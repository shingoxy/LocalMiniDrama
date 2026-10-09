const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const { request, localImage, upload, watchProgress, cancel } = require('./comfyClient');
const templateDir = path.resolve(__dirname, '../../configs/workflows');
function loadTemplate(mode = 'I2VA') {
  const workflow = JSON.parse(fs.readFileSync(path.join(templateDir, 'minimax_h3.json'), 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(path.join(templateDir, 'minimax_h3.mapping.json'), 'utf8'));
  if (!mapping.supported_modes.includes(mode)) throw new Error('当前 H3 Workflow 不支持该模式');
  if (mode === 'FL2VA') {
    workflow.last_frame_upload = { class_type: 'LoadImage', inputs: { image: '' } };
    workflow.last_frame_resized = { class_type: 'ImageScale', inputs: { image: ['last_frame_upload', 0], upscale_method: 'lanczos', width: ['120', 0], height: ['120', 1], crop: 'disabled' } };
    workflow[mapping.fields.prompt.node].inputs.last_frame = ['last_frame_resized', 0];
    mapping.fields.last_frame = { node: 'last_frame_upload', input: 'image' };
    mapping.mode = 'FL2VA';
  }
  for (const [name, field] of Object.entries(mapping.fields)) {
    if (field && (!workflow[field.node] || !(field.input in workflow[field.node].inputs))) throw new Error('H3 Mapping 无效: ' + name);
  }
  return { workflow, mapping };
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
      // Runtime reference images are uploaded after connection validation.
      if (n.class_type === 'LoadImage' && key === 'image') continue;
      if (Array.isArray(definition?.[0]) && typeof value === 'string' && !definition[0].includes(value)) throw new Error(`当前模型或 LoRA 不可用: ${value}`);
    }
  }
  return true;
}
function bindWorkflow(input) {
  const { workflow, mapping } = loadTemplate(input.last_frame ? 'FL2VA' : 'I2VA');
  function set(field, value) {
    if (value == null) return;
    const target = mapping.fields[field];
    if (!target) throw new Error('当前 Workflow 未映射: ' + field);
    workflow[target.node].inputs[target.input] = value;
  }
  if (input.audio) throw new Error('当前 Workflow 未连接外部音频');
  if (input.last_frame && !input.image) throw new Error('FL2VA 首帧未连接，请同时提供首尾帧');
  if (input.fps != null && Number(input.fps) !== mapping.native_fps) throw new Error('当前 Workflow 帧计算固定为 24 FPS');
  if (!(input.duration >= 4 && input.duration <= 15)) throw new Error('H3 时长必须为 4–15 秒');
  for (const name of ['width','height']) if (input[name] != null && (!Number.isInteger(input[name]) || input[name] < 32 || input[name] % 32)) throw new Error('H3 宽高必须为 32 的倍数');
  set('prompt', input.prompt); set('first_frame', input.image); set('duration', input.duration);
  set('seed', input.seed ?? Math.floor(Math.random()*Number.MAX_SAFE_INTEGER));
  set('width', input.width); set('height', input.height); set('fps', input.fps);
  if (input.last_frame) {
    set('last_frame', input.last_frame);
    workflow.last_frame_resized.inputs.width = workflow[mapping.fields.prompt.node].inputs.width;
    workflow.last_frame_resized.inputs.height = workflow[mapping.fields.prompt.node].inputs.height;
  }
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
module.exports = { loadTemplate, request, connection, validateNodes, localImage, upload, bindWorkflow, waitForOutput, download, probeDuration, watchProgress, cancel };
