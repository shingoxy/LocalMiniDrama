const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const sharp = require('sharp');
const comfy = require('./comfyClient');
const ImageRequestError = require('./imageRequestError');
const KEYS = ['qwen_image_21_t2i', 'qwen_image_21_edit'];
function loadTemplate(key) {
  if (!KEYS.includes(key)) throw new ImageRequestError('本地图片工作流无效');
  const dir = path.resolve(__dirname, '../../configs/workflows');
  const workflow = JSON.parse(fs.readFileSync(path.join(dir, key + '.json'), 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(path.join(dir, key + '.mapping.json'), 'utf8'));
  for (const [name, f] of Object.entries(mapping.fields)) if (!workflow[f.node] || !(f.input in workflow[f.node].inputs)) throw new Error('图片 Mapping 无效: ' + name);
  return { workflow, mapping };
}
function dimensions(size, multiple) {
  const match = /^(\d+)x(\d+)$/.exec(size || '1024x1024');
  if (!match) throw new ImageRequestError('本地图片尺寸须为 WIDTHxHEIGHT');
  const [width, height] = match.slice(1).map(Number);
  if ([width, height].some(v => v < 256 || v > 4096 || v % multiple)) throw new ImageRequestError(`本地图片宽高须在 256–4096，且为 ${multiple} 的倍数；不会自动降分辨率`);
  return { width, height };
}
function bindWorkflow(input) {
  const { workflow, mapping } = loadTemplate(input.workflow_key);
  const refs = input.references || [];
  if (refs.length > mapping.max_references) throw new Error('参考图超出工作流上限或该工作流不支持参考图编辑');
  if (mapping.mode === 'edit' && !refs.length) throw new Error('Qwen 编辑需要参考图');
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error('Seed 必须为非负安全整数');
  const size = dimensions(input.size, mapping.size_multiple);
  const set = (name, value) => { const f = mapping.fields[name]; workflow[f.node].inputs[f.input] = value; };
  set('prompt', String(input.prompt || '')); set('negative_prompt', String(input.negative_prompt || ''));
  set('seed', input.seed); set('width', size.width); set('height', size.height); set('output', 'LocalMiniDrama/images/' + randomUUID());
  refs.forEach((image, i) => {
    const id = 'ref_' + (i + 1);
    workflow[id] = { class_type: 'LoadImage', inputs: { image } };
    if (mapping.first_reference_canvas && i === 0) return;
    if (mapping.mode === 'edit') {
      const resized = 'ref_resize_' + (i + 1);
      workflow[resized] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [id, 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 32 } };
      workflow[mapping.reference_node].inputs[mapping.reference_input_prefix + (i + 1)] = [resized, 0];
    } else workflow[mapping.reference_node].inputs[mapping.reference_input_prefix + (i + 1)] = [id, 0];
  });
  if (input.lora?.name) {
    if (input.purpose !== 'character' && !input.lora.character_id) throw new Error('角色 LoRA 必须明确关联人物');
    if (!Number.isFinite(input.lora.strength) || Math.abs(input.lora.strength) > 2) throw new Error('LoRA 强度须在 -2–2');
    workflow.identity_lora = { class_type: 'LoraLoaderModelOnly', inputs: { model: [mapping.model_node, 0], lora_name: input.lora.name, strength_model: input.lora.strength } };
    workflow['6'].inputs.model = ['identity_lora', 0];
  }
  return { workflow, mapping, ...size };
}
async function validate(base, workflow) {
  const info = await comfy.request(base, '/object_info', null, {}, 20000);
  for (const [id, node] of Object.entries(workflow)) {
    const def = info[node.class_type];
    if (!def) throw new Error(`ComfyUI 缺少图片节点 ${id}: ${node.class_type}`);
    for (const [key, value] of Object.entries(node.inputs)) {
      if (node.class_type === 'LoadImage') continue;
      const field = def.input?.required?.[key] || def.input?.optional?.[key];
      const choices = Array.isArray(field?.[0]) ? field[0] : field?.[1]?.options;
      if (Array.isArray(choices) && typeof value === 'string' && !choices.some(choice => (typeof choice === 'object' ? choice?.key : choice) === value)) throw new Error('ComfyUI 权重或参数不可用: ' + value);
    }
  }
  return true;
}
async function waitForOutput(base, promptId, mapping, options = {}) {
  let executionStart = null;
  const submitted = Date.now();
  const queueTimeout = (options.queue_timeout_minutes || 120) * 60000;
  const runTimeout = (options.timeout_minutes || 120) * 60000;
  for (;;) {
    if (options.isCancelled?.()) throw new Error('本地图片任务已取消');
    const history = (await comfy.request(base, '/history/' + encodeURIComponent(promptId)))[promptId];
    if (history) {
      const messages = history.status?.messages || [];
      if (history.status?.status_str === 'error') throw new Error(messages.find(m => m[0] === 'execution_error')?.[1]?.exception_message || 'ComfyUI 执行失败或中断');
      const output = history.outputs?.[mapping.fields.output.node]?.images?.find(f => /\.(png|jpe?g|webp)$/i.test(f.filename || ''));
      if (output) return { output, history };
      if (history.status?.completed) throw new Error('ComfyUI 输出节点没有图片');
    }
    const queue = await comfy.request(base, '/queue');
    const running = queue.queue_running?.some(q => q[1] === promptId);
    const position = queue.queue_pending?.findIndex(q => q[1] === promptId) ?? -1;
    if (running && !executionStart) executionStart = Date.now();
    options.onProgress?.({ status: running ? 'running' : position >= 0 ? 'queued' : 'waiting', queue_position: position + 1 });
    if (!running && position < 0 && !history) throw new Error('ComfyUI 图片任务已消失（重启或取消）；不会重复提交');
    if ((executionStart ? Date.now() - executionStart > runTimeout : Date.now() - submitted > queueTimeout)) throw Object.assign(new Error('ComfyUI 图片超时；任务可能仍在运行，可继续查询'), { resumable: true });
    await new Promise(r => setTimeout(r, options.poll_interval_ms || 2000));
  }
}
async function download(base, output, destination, expected) {
  const url = new URL(base.replace(/\/$/, '') + '/view?' + new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' }));
  const tmp = destination + '.part';
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let count = 0;
  try {
    await new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).get(url, res => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('ComfyUI 图片下载 HTTP ' + res.statusCode)); }
        const limit = new Transform({ transform(chunk, enc, cb) { count += chunk.length; cb(count > 50 * 1024 * 1024 ? new Error('图片超过 50MB') : null, chunk); } });
        pipeline(res, limit, fs.createWriteStream(tmp)).then(resolve, reject);
      });
      req.setTimeout(120000, () => req.destroy(new Error('ComfyUI 图片下载超时'))); req.on('error', reject);
    });
    const image = sharp(tmp, { limitInputPixels: 4096 * 4096 });
    const metadata = await image.metadata();
    // Decode the complete image; a readable header does not prove an intact result.
    await image.stats();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || metadata.width !== expected.width || metadata.height !== expected.height) throw new Error('ComfyUI 图片损坏或实际尺寸与请求不符');
    fs.renameSync(tmp, destination);
    return { width: metadata.width, height: metadata.height };
  } catch (err) { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); throw err; }
}
module.exports = { KEYS, loadTemplate, dimensions, bindWorkflow, validate, waitForOutput, download };
