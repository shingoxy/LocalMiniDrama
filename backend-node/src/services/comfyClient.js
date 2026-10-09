const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { randomUUID } = require('crypto');
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

async function cancel(base,promptId) {
  const queue = await request(base,'/queue');
  if (queue.queue_pending?.some(q=>q[1]===promptId)) { await request(base,'/queue',{delete:[promptId]}); return; }
  if (queue.queue_running?.some(q=>q[1]===promptId)) {
    if (queue.queue_running.length !== 1) throw new Error('ComfyUI 仅支持全局 interrupt；当前有其他任务，不能安全取消');
    await request(base,'/interrupt',{}); return;
  }
  throw new Error('任务已完成或不在 Queue 中');
}

module.exports = { request, localImage, upload, watchProgress, cancel };
