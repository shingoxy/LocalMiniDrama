const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const templateDir = path.resolve(__dirname, '../../configs/workflows');
function loadTemplate() {
  const workflow = JSON.parse(fs.readFileSync(path.join(templateDir, 'minimax_h3.json'), 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(path.join(templateDir, 'minimax_h3.mapping.json'), 'utf8'));
  for (const [name, field] of Object.entries(mapping.fields)) {
    if (field && (!workflow[field.node] || !(field.input in workflow[field.node].inputs))) throw new Error('H3 Mapping 无效: ' + name);
  }
  return { workflow, mapping };
}
function request(base, endpoint, body = null, headers = {}, timeout = 10000) {
  const url = new URL(base.replace(/\/$/, '') + endpoint);
  const bytes = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: body == null ? 'GET' : 'POST', headers: { ...(bytes && { 'Content-Type': 'application/json', 'Content-Length': bytes.length }), ...headers },
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 20 * 1024 * 1024) res.destroy(new Error('ComfyUI 响应过大')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`ComfyUI HTTP ${res.statusCode}: ${text.slice(0,1000)}`));
        try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('ComfyUI 返回了非 JSON 响应')); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('ComfyUI 请求超时')));
    req.on('error', err => reject(new Error(/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(err.code || '') ? 'ComfyUI Offline' : err.message)));
    if (bytes) req.write(bytes);
    req.end();
  });
}
async function connection(base) {
  const system = await request(base, '/system_stats');
  const { mapping } = loadTemplate();
  return { online: true, system: system.system?.comfyui_version, address: base, mapping };
}
async function validateNodes(base) {
  const info = await request(base, '/object_info', null, {}, 20000);
  const { workflow } = loadTemplate();
  for (const [id, n] of Object.entries(workflow)) {
    if (!info[n.class_type]) throw new Error(`ComfyUI 缺少现有 Workflow 节点 ${id}: ${n.class_type}`);
    for (const [key, value] of Object.entries(n.inputs)) {
      const definition = info[n.class_type].input?.required?.[key] || info[n.class_type].input?.optional?.[key];
      if (Array.isArray(definition?.[0]) && typeof value === 'string' && !definition[0].includes(value)) throw new Error(`当前模型或 LoRA 不可用: ${value}`);
    }
  }
  return true;
}
function localImage(source, root) {
  if (!source) throw new Error('当前 I2VA Workflow 需要 Storyboard 首帧图像');
  let relative = String(source);
  if (/^https?:/i.test(relative)) {
    const u = new URL(relative);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !u.pathname.startsWith('/static/')) throw new Error('本地 H3 请先将远程参考图导入 Media Library');
    relative = u.pathname;
  }
  relative = decodeURIComponent(relative.replace(/^\/?static\//, ''));
  const file = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('参考图不在 Media Library 中');
  if (!fs.existsSync(file) || fs.statSync(file).size > 50 * 1024 * 1024) throw new Error('参考图不存在或大于 50MB');
  return file;
}
async function upload(base, file) {
  const boundary = '----LocalMiniDrama' + randomUUID();
  const name = 'lmd_' + randomUUID() + (path.extname(file).toLowerCase() || '.png');
  const bytes = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fs.readFileSync(file), Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n--${boundary}--\r\n`)]);
  const r = await request(base, '/upload/image', bytes, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, 30000);
  if (!r.name) throw new Error('ComfyUI 上传未返回图像名');
  return r.subfolder ? r.subfolder + '/' + r.name : r.name;
}
function bindWorkflow(input) {
  const { workflow, mapping } = loadTemplate();
  function set(field, value) {
    if (value == null) return;
    const target = mapping.fields[field];
    if (!target) throw new Error('当前 Workflow 未映射: ' + field);
    workflow[target.node].inputs[target.input] = value;
  }
  if (input.last_frame || input.audio) throw new Error('当前 I2VA Workflow 未连接尾帧/外部音频，请使用已验证的首帧模式');
  if (input.fps != null && Number(input.fps) !== mapping.native_fps) throw new Error('当前 Workflow 帧计算固定为 24 FPS');
  if (!(input.duration >= 4 && input.duration <= 15)) throw new Error('H3 时长必须为 4–15 秒');
  for (const name of ['width','height']) if (input[name] != null && (!Number.isInteger(input[name]) || input[name] < 32 || input[name] % 32)) throw new Error('H3 宽高必须为 32 的倍数');
  set('prompt', input.prompt); set('first_frame', input.image); set('duration', input.duration);
  set('seed', input.seed ?? Math.floor(Math.random()*Number.MAX_SAFE_INTEGER));
  set('width', input.width); set('height', input.height); set('fps', input.fps);
  set('output', 'LocalMiniDrama/' + randomUUID());
  return { workflow, mapping };
}
function findOutput(history, mapping) {
  const output = history.outputs?.[mapping.fields.output.node] || {};
  const files = mapping.fields.output.media_keys.flatMap(k=>output[k] || []);
  return files.filter(f=>/\.mp4$/i.test(f.filename || '')).at(-1);
}
async function download(base, output, destination) {
  const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
  const url = new URL(base.replace(/\/$/,'') + '/view?' + query);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmp = destination + '.part';
  try {
    await new Promise((resolve,reject) => {
      const req = (url.protocol === 'https:' ? https : http).get(url,res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('ComfyUI Output Retrieval HTTP ' + res.statusCode)); return; }
        pipeline(res,fs.createWriteStream(tmp)).then(resolve,reject);
      });
      req.setTimeout(120000,()=>req.destroy(new Error('MP4 下载超时'))); req.on('error',reject);
    });
    const fd = fs.openSync(tmp,'r'); const head = Buffer.alloc(16); fs.readSync(fd,head,0,16,0); fs.closeSync(fd);
    if (!head.includes(Buffer.from('ftyp'))) throw new Error('ComfyUI 输出不是 MP4');
    fs.renameSync(tmp,destination);
  } catch (err) { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); throw err; }
}
function probeDuration(file) {
  const probe = require('../utils/ffmpegPath').getFfprobePath();
  const result = spawnSync(probe, ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{encoding:'utf8',windowsHide:true,timeout:30000});
  const duration = Number(result.stdout?.trim());
  return result.status === 0 && duration > 0 ? duration : null;
}
function watchProgress(base,clientId,getPromptId,onProgress) {
  if (!globalThis.WebSocket) return ()=>{};
  const url=new URL(base.replace(/\/$/,'')+'/ws');
  url.protocol=url.protocol==='https:' ? 'wss:' : 'ws:';url.searchParams.set('clientId',clientId);
  const socket=new WebSocket(url);
  socket.addEventListener('error',()=>{}); // History/queue polling remains authoritative.
  socket.addEventListener('message',event=>{
    if (typeof event.data!=='string') return;
    try {
      const message=JSON.parse(event.data);
      if (message.type==='progress' && message.data.prompt_id===getPromptId()) onProgress(message.data);
      if (message.type==='executing' && message.data.prompt_id===getPromptId()) onProgress(null);
    } catch {}
  });
  return ()=>socket.close();
}
async function waitForOutput(base, promptId, mapping, options = {}) {
  const deadline = Date.now()+(options.timeout_minutes || 120)*60000;
  while (Date.now()<deadline) {
    if (options.isCancelled?.()) throw new Error('Local generation cancelled');
    const all = await request(base, '/history/' + encodeURIComponent(promptId));
    const history = all[promptId];
    if (history) {
      if (history.status?.status_str === 'error') {
        const err = history.status.messages?.find(m=>m[0]==='execution_error')?.[1];
        const interrupted=history.status.messages?.some(m=>m[0]==='execution_interrupted');
        throw new Error('Local generation failed: ' + (err?.exception_message || (interrupted ? 'ComfyUI execution interrupted' : 'ComfyUI execution error')));
      }
      const output = findOutput(history,mapping);
      if (output) return { output, history };
      if (history.status?.completed) throw new Error('Local generation failed: Output 节点没有 MP4');
    }
    const queue = await request(base,'/queue');
    const running = queue.queue_running?.some(q=>q[1]===promptId);
    const pending = queue.queue_pending?.some(q=>q[1]===promptId);
    options.onProgress?.({ status: running ? 'running' : pending ? 'queued' : 'waiting', queue_position: pending ? queue.queue_pending.findIndex(q=>q[1]===promptId)+1 : 0 });
    if (!running && !pending && !history) throw new Error('Local generation failed: ComfyUI 任务已消失（重启或取消）');
    await new Promise(r=>setTimeout(r, options.poll_interval_ms || 2000));
  }
  throw new Error('Local generation failed: ComfyUI 超时；使用继续查询可取回仍在运行的任务');
}
async function cancel(base,promptId) {
  const queue = await request(base,'/queue');
  if (queue.queue_pending?.some(q=>q[1]===promptId)) { await request(base,'/queue',{delete:[promptId]}); return; }
  if (queue.queue_running?.some(q=>q[1]===promptId)) {
    if (queue.queue_running.length !== 1) throw new Error('ComfyUI 仅支持全局 interrupt；当前有其他任务，不能安全取消');
    await request(base,'/interrupt',{}); return;
  }
  throw new Error('任务已完成或不在 Queue 中');
}
module.exports = { loadTemplate, request, connection, validateNodes, localImage, upload, bindWorkflow, waitForOutput, download, probeDuration, watchProgress, cancel };
