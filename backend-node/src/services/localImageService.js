const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const sharp = require('sharp');
const models = require('./imageModelSelection');
const provider = require('./comfyImageProvider');
const comfy = require('./comfyClient');
const tasks = require('./taskService');
const settings = require('./settingsService');
const layout = require('./storageLayout');
const active = new Set();
const json = value => layout.parseMetadata(value);
const FIELDS = ['engine', 'model_key', 'workflow_key', 'workflow_version', 'seed', 'provider_task_id', 'generation_elapsed_seconds', 'generation_metadata', 'width', 'height'];
function requestOptions(body = {}) {
  return Object.fromEntries(['image_model_key', 'generation_mode', 'seed', 'workflow_key', 'local_size', 'lora', 'reference_images'].filter(k => body[k] !== undefined).map(k => [k, body[k]]));
}
function metadataFields(row) { return Object.fromEntries(FIELDS.map(key => [key, key === 'generation_metadata' ? json(row[key]) : row[key]])); }
function config(db) {
  return { default_size: '1024x1024', timeout_minutes: 120, queue_timeout_minutes: 120, ...settings.getGlobalSetting(db, 'local_image_settings', {}) };
}
function saveConfig(db, input) {
  const next = { ...config(db) };
  if (input.default_size != null) { provider.dimensions(input.default_size, 32); next.default_size = input.default_size; }
  for (const key of ['timeout_minutes', 'queue_timeout_minutes']) if (input[key] != null) {
    if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > 1440) throw new Error('图片超时须为 1–1440 分钟');
    next[key] = input[key];
  }
  settings.setGlobalSetting(db, 'local_image_settings', next);
  return next;
}
function prepare(db, body) {
  const selection = models.resolve(db, body);
  if (!selection?.local) return { selection };
  const use = models.purpose(body);
  const requestedMode = body.generation_mode || 'auto';
  if (!['auto', 't2i', 'edit'].includes(requestedMode)) throw new Error('本地图片生成模式无效');
  const explicitRefs = body.reference_images || body.reference_image_urls || [];
  if (!Array.isArray(explicitRefs)) throw new Error('参考图必须为数组');
  if (explicitRefs.length > selection.references) throw new Error('参考图超限，或 Flux 不支持参考图编辑');
  if (requestedMode === 't2i' && explicitRefs.length) throw new Error('文生图模式不能丢弃已提供的参考图，请选择编辑模式');
  if (requestedMode === 'edit' && !selection.modes.includes('edit')) throw new Error('Flux 当前工作流不支持参考图编辑，请选择 Qwen');
  // Flux auto is explicitly text-only. A requested edit or explicit reference is never discarded.
  const mode = requestedMode === 'auto' ? selection.references && (explicitRefs.length || body.storyboard_id || use === 'last') ? 'edit' : 't2i' : requestedMode;
  const key = body.workflow_key || (selection.model === 'flux1-dev' ? 'flux1_dev_t2i' : 'qwen_image_21_' + mode);
  const { mapping } = provider.loadTemplate(key);
  if (mapping.model_key !== selection.key || mapping.mode !== mode) throw new Error('工作流与所选模型/模式不一致');
  const seed = body.seed == null ? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) : Number(body.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Seed 必须为非负安全整数');
  // Legacy asset sizes were cloud presets. Only an explicit local_size/size in /images opts in to those pixels.
  const size = body.local_size || (body.local_size_explicit ? body.size : null) || config(db).default_size;
  provider.dimensions(size, mapping.size_multiple);
  if (body.lora?.name) {
    const charId = Number(body.lora.character_id || body.character_id);
    if (!charId) throw new Error('请选择该 LoRA 对应的人物');
    models.projectId(db, { drama_id: models.projectId(db, body), character_id: charId });
    if (body.character_id && Number(body.character_id) !== charId) throw new Error('LoRA 关联人物与生成目标不同');
  }
  return { selection, size, seed, key, mode, metadata: { purpose: use, result_usage: 'candidate', input: { generation_mode: requestedMode, reference_images: explicitRefs, lora: body.lora || null, size, size_explicit: !!body.local_size || !!(body.local_size_explicit && body.size) }, cancel_requested: false } };
}
function record(db, id, prepared) {
  if (!prepared.selection) return;
  if (!prepared.selection.local) {
    db.prepare('UPDATE image_generations SET engine = ?, model_key = ?, model = ? WHERE id = ?').run('cloud', prepared.selection.key, prepared.selection.model, id);
    return;
  }
  db.prepare('UPDATE image_generations SET provider = ?, model = ?, engine = ?, model_key = ?, workflow_key = ?, workflow_version = ?, seed = ?, size = ?, generation_mode = ?, generation_metadata = ? WHERE id = ?')
    .run('local_comfyui', prepared.selection.model, 'comfyui', prepared.selection.key, prepared.key, 1, prepared.seed, prepared.size, prepared.mode, JSON.stringify(prepared.metadata), id);
}
function rootPath() {
  const cfg = require('../config').loadConfig();
  return path.resolve(cfg.storage?.local_path || './data/storage');
}
function references(db, row, input) {
  const result = [];
  const push = (source, role) => { if (source && !result.some(r => r.source === source)) result.push({ source, role }); };
  const shot = row.storyboard_id ? db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(row.storyboard_id) : null;
  if (models.purpose(row) === 'last') {
    const first = shot?.first_frame_image_id ? db.prepare('SELECT local_path,image_url FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(shot.first_frame_image_id) : null;
    const source = first?.local_path || first?.image_url || shot?.local_path || shot?.image_url;
    if (!source) throw new Error('Qwen 尾帧编辑需要先选定该分镜首帧');
    push(source, 'first frame: preserve identity, clothing, composition and spatial positions; edit only the end action');
  }
  for (const ref of input.reference_images || []) {
    if (typeof ref === 'number' || (typeof ref === 'object' && ref.image_generation_id)) {
      const image = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL AND status = ?').get(Number(typeof ref === 'number' ? ref : ref.image_generation_id), 'completed');
      if (!image || Number(image.drama_id || 0) !== Number(row.drama_id || 0)) throw new Error('参考图片不存在或不属于该项目');
      push(image.local_path || image.image_url, ref.role || 'user reference');
    } else if (typeof ref === 'string') push(ref, 'user reference');
    else throw new Error('参考图格式无效');
  }
  let ids = [];
  try { ids = JSON.parse(shot?.characters || '[]'); } catch { throw new Error('分镜人物关联数据损坏'); }
  if (!Array.isArray(ids)) throw new Error('分镜人物关联数据无效');
  if (row.character_id) ids = [row.character_id];
  for (const item of ids) {
    const id = Number(typeof item === 'object' ? item.id : item);
    const char = db.prepare('SELECT * FROM characters WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!char || Number(char.drama_id) !== Number(row.drama_id)) throw new Error('人物参考不属于该项目');
    push(char.ref_image || char.local_path || char.image_url, 'fixed identity reference: ' + char.name);
  }
  const sceneId = shot?.scene_id || row.scene_id;
  if (sceneId) {
    const scene = db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(sceneId);
    if (!scene || Number(scene.drama_id) !== Number(row.drama_id)) throw new Error('场景参考不属于该项目');
    push(scene.ref_image || scene.local_path || scene.image_url, 'scene and environment reference: ' + scene.location);
  }
  return result;
}
async function localReference(source, root, projectPrefix) {
  const file = comfy.localImage(source, root);
  const real = fs.realpathSync(file), realRoot = fs.realpathSync(root);
  const relative = path.relative(realRoot, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('参考图不在素材目录中');
  const slash = relative.replace(/\\/g, '/');
  if (slash.startsWith('projects/') && (!projectPrefix || !slash.startsWith(projectPrefix + '/'))) throw new Error('参考图不属于该项目');
  const meta = await sharp(real, { limitInputPixels: 4096 * 4096 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) throw new Error('本地参考图仅支持 PNG/JPEG/WebP');
  return real;
}
function updateMetadata(db, id, patch) {
  const row = db.prepare('SELECT generation_metadata FROM image_generations WHERE id = ?').get(id);
  const meta = { ...json(row?.generation_metadata), ...patch };
  db.prepare('UPDATE image_generations SET generation_metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), new Date().toISOString(), id);
  return meta;
}
function cancelled(db, id) {
  const row = db.prepare('SELECT status,generation_metadata,deleted_at FROM image_generations WHERE id = ?').get(id);
  return !row || !!row.deleted_at || row.status === 'cancelled' || json(row.generation_metadata).cancel_requested === true;
}
async function run(db, log, id, resume = false) {
  if (active.has(id)) return;
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row || row.engine !== 'comfyui' || row.status === 'completed' || cancelled(db, id)) return;
  active.add(id);
  let promptId = resume ? row.provider_task_id : null;
  try {
    const meta = json(row.generation_metadata), input = meta.input || {}, root = rootPath();
    const base = meta.comfy_url || require('./costEngine').settings(db).comfy_url;
    db.prepare("UPDATE image_generations SET status = 'processing', error_msg = NULL WHERE id = ?").run(id);
    tasks.updateTaskStatus(db, row.task_id, 'processing', 0, resume ? '继续查询本地图片' : '准备本地图片');
    const { mapping } = provider.loadTemplate(row.workflow_key);
    if (!promptId) {
      if (row.storyboard_id && ['quad_grid', 'nine_grid'].includes(row.frame_type)) {
        const grid = require('./imageService');
        try {
          const builder = row.frame_type === 'quad_grid' ? grid.buildQuadGridPrompt : grid.buildNineGridPrompt;
          row.prompt = await builder(db, log, require('../config').loadConfig(), row.storyboard_id) || row.prompt;
          db.prepare('UPDATE image_generations SET prompt = ? WHERE id = ?').run(row.prompt, id);
        } catch (err) { log.warn('Local grid prompt uses original description', { error: err.message }); }
      }
      let refs = row.generation_mode === 'edit' ? references(db, row, input) : [];
      if (refs.length > mapping.max_references) throw new Error(`参考图共 ${refs.length} 张，超过 ${mapping.max_references} 张上限；请减少参考图`);
      if (row.generation_mode === 'edit' && !refs.length && input.generation_mode === 'auto' && models.purpose(row) !== 'last') {
        db.prepare('UPDATE image_generations SET workflow_key = ?, generation_mode = ? WHERE id = ?').run('qwen_image_21_t2i', 't2i', id);
        row.workflow_key = 'qwen_image_21_t2i'; row.generation_mode = 't2i';
      }
      const projectPrefix = layout.getProjectStorageSubdir(db, row.drama_id);
      const uploaded = [], recorded = [];
      for (const ref of refs) {
        const file = await localReference(ref.source, root, projectPrefix);
        if (models.purpose(row) === 'last' && uploaded.length === 0) {
          const firstSize = await sharp(file).metadata();
          const size = `${firstSize.width}x${firstSize.height}`;
          provider.dimensions(size, mapping.size_multiple);
          if (input.size_explicit && row.size !== size) throw new Error('尾帧尺寸须与已选首帧一致：' + size);
          row.size = size;
          db.prepare('UPDATE image_generations SET size = ? WHERE id = ?').run(size, id);
          updateMetadata(db, id, { input: { ...input, size } });
        }
        uploaded.push(await comfy.upload(base, file));
        recorded.push({ role: ref.role, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
      }
      const layoutInstruction = row.storyboard_id && !['quad_grid', 'nine_grid'].includes(row.frame_type)
        ? 'Generate one continuous image. Use references for identity/environment, do not reproduce reference sheets.'
        : 'Follow the requested layout, including explicitly requested reference sheets or storyboard grids. Use references for identity and environment.';
      const prompt = [refs.map((r, i) => `Image ${i + 1}: ${r.role}.`).join('\n'), layoutInstruction, row.prompt].filter(Boolean).join('\n\n');
      const bound = provider.bindWorkflow({ workflow_key: row.workflow_key, references: uploaded, prompt, negative_prompt: row.negative_prompt, size: row.size, seed: row.seed, lora: input.lora, purpose: meta.purpose });
      await provider.validate(base, bound.workflow);
      if (cancelled(db, id)) return;
      const response = await comfy.request(base, '/prompt', { prompt: bound.workflow, client_id: randomUUID() }, {}, 30000);
      if (!response.prompt_id || Object.keys(response.node_errors || {}).length) throw new Error('ComfyUI 未接受图片任务: ' + JSON.stringify(response.node_errors || response.error || {}));
      promptId = response.prompt_id;
      db.prepare('UPDATE image_generations SET provider_task_id = ? WHERE id = ?').run(promptId, id);
      updateMetadata(db, id, { comfy_url: base, references: recorded, compiled_prompt: prompt, submitted_at: new Date().toISOString(), workflow_snapshot: bound.workflow });
      if (cancelled(db, id)) { await comfy.cancel(base, promptId); return; }
    }
    const result = await provider.waitForOutput(base, promptId, provider.loadTemplate(row.workflow_key).mapping, {
      ...config(db), isCancelled: () => cancelled(db, id), onProgress: progress => {
        if (cancelled(db, id)) return;
        updateMetadata(db, id, { progress });
        tasks.updateTaskStatus(db, row.task_id, 'processing', 0, progress.status === 'queued' ? '本地图片排队：第 ' + progress.queue_position + ' 项' : '本地图片生成中');
      },
    });
    const project = layout.getProjectStorageSubdir(db, row.drama_id);
    const relative = [project || 'library', row.character_id ? 'characters' : row.scene_id ? 'scenes' : 'images', 'ig_' + id + '_' + randomUUID() + path.extname(result.output.filename).toLowerCase()].join('/');
    const dims = await provider.download(base, result.output, path.join(root, relative), provider.dimensions(row.size, mapping.size_multiple));
    if (cancelled(db, id)) return;
    if (['quad_grid', 'nine_grid'].includes(row.frame_type)) {
      const grid = require('./imageService');
      const split = row.frame_type === 'quad_grid' ? grid.splitQuadGridToImages : grid.splitNineGridToImages;
      await split(db, log, row, path.join(root, relative), root, '/static/' + relative);
      const base = relative.slice(0, -path.extname(relative).length);
      const children = db.prepare('SELECT * FROM image_generations WHERE local_path LIKE ? AND deleted_at IS NULL').all(base + '_panel%');
      const count = row.frame_type === 'quad_grid' ? 4 : 9;
      if (children.length !== count) throw new Error('本地宫格拆分未完整完成，请检查图片历史');
      for (const child of children) {
        const size = await sharp(path.join(root, child.local_path)).metadata();
        db.prepare('UPDATE image_generations SET engine = ?, model_key = ?, workflow_key = ?, workflow_version = ?, seed = ?, generation_mode = ?, generation_metadata = ?, width = ?, height = ? WHERE id = ?')
          .run('comfyui', row.model_key, row.workflow_key, row.workflow_version, row.seed, 'crop', JSON.stringify({ result_usage: 'candidate', parent_image_generation_id: row.id }), size.width, size.height, child.id);
      }
    }
    const messages = result.history.status?.messages || [];
    const started = messages.find(m => m[0] === 'execution_start')?.[1]?.timestamp;
    const finished = [...messages].reverse().find(m => m[0] === 'execution_success')?.[1]?.timestamp;
    const seconds = Number.isFinite(started) && Number.isFinite(finished) ? (finished - started) / 1000 : null;
    const now = new Date().toISOString();
    const submittedAt = Date.parse(json(db.prepare('SELECT generation_metadata FROM image_generations WHERE id = ?').get(id).generation_metadata).submitted_at || '');
    const queueSeconds = Number.isFinite(submittedAt) && Number.isFinite(started) && started >= submittedAt ? (started - submittedAt) / 1000 : null;
    updateMetadata(db, id, { progress: { status: 'completed' }, resumable: false, queue_elapsed_seconds: queueSeconds, execution_elapsed_seconds: seconds });
    db.prepare("UPDATE image_generations SET status = 'completed', local_path = ?, image_url = ?, width = ?, height = ?, generation_elapsed_seconds = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status <> 'cancelled'")
      .run(relative, '/static/' + relative, dims.width, dims.height, seconds, now, now, id);
    tasks.updateTaskResult(db, row.task_id, { image_generation_id: id, image_url: '/static/' + relative, local_path: relative, status: 'completed', result_usage: 'candidate' });
    log.info('Local image completed; awaiting selection', { image_gen_id: id, model_key: row.model_key });
  } catch (err) {
    const current = db.prepare('SELECT status FROM image_generations WHERE id = ?').get(id);
    if (!cancelled(db, id) && current?.status !== 'completed') {
      updateMetadata(db, id, { resumable: !!err.resumable });
      db.prepare("UPDATE image_generations SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?").run(String(err.message).slice(0, 1000), new Date().toISOString(), id);
      tasks.updateTaskError(db, row.task_id, err.message);
    }
    log.error('Local image failed', { image_gen_id: id, error: err.message });
  } finally { active.delete(id); }
}
async function cancel(db, id) {
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row || row.engine !== 'comfyui') throw new Error('本地图片记录不存在');
  if (row.status === 'completed' || row.status === 'cancelled') return;
  if (row.provider_task_id) await comfy.cancel(json(row.generation_metadata).comfy_url || require('./costEngine').settings(db).comfy_url, row.provider_task_id);
  updateMetadata(db, row.id, { cancel_requested: true, resumable: false });
  db.prepare("UPDATE image_generations SET status = 'cancelled', error_msg = '用户已取消' WHERE id = ?").run(row.id);
  tasks.updateTaskError(db, row.task_id, '用户已取消');
}
function resume(db, log, id) {
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row || row.engine !== 'comfyui' || !row.provider_task_id || cancelled(db, row.id)) throw new Error('该图片没有可继续查询的本地任务');
  setImmediate(() => run(db, log, row.id, true));
  return { id: row.id, task_id: row.task_id };
}
function recover(db, log) {
  const unsubmitted = db.prepare("SELECT id,task_id FROM image_generations WHERE engine = 'comfyui' AND provider_task_id IS NULL AND status IN ('pending','processing') AND deleted_at IS NULL").all();
  for (const row of unsubmitted) {
    db.prepare("UPDATE image_generations SET status = 'failed', error_msg = '服务重启前图片任务尚未提交，请重新生成' WHERE id = ?").run(row.id);
    tasks.updateTaskError(db, row.task_id, '服务重启前图片任务尚未提交，请重新生成');
  }
  const rows = db.prepare("SELECT id,task_id FROM image_generations WHERE engine = 'comfyui' AND provider_task_id IS NOT NULL AND status = 'processing' AND deleted_at IS NULL").all();
  for (const row of rows) setImmediate(() => run(db, log, row.id, true));
  return rows.map(r => r.task_id);
}
function adopt(db, id, body = {}) {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL AND status = 'completed'").get(Number(id));
    if (!row || !row.local_path) throw new Error('请选择已完成且已保存的图片');
    models.projectId(db, row);
    const now = new Date().toISOString();
    if (row.storyboard_id) {
      const type = body.frame_type || row.frame_type || 'first';
      if (!['first', 'storyboard_first', 'first_frame', 'last', 'storyboard_last', 'tail', 'last_frame'].includes(type)) throw new Error('该候选不是可选用的首尾帧');
      require('./storyboardFrameBinding').bindStoryboardFrameImage(db, row.storyboard_id, type, row.id, row.image_url, row.local_path);
    } else if (row.character_id || row.scene_id) {
      const table = row.character_id ? 'characters' : 'scenes', target = row.character_id || row.scene_id;
      const old = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(target);
      let extras = []; try { extras = JSON.parse(old.extra_images || '[]'); } catch {}
      if (!Array.isArray(extras)) extras = [];
      const previous = old.local_path || old.image_url;
      if (previous && !extras.includes(previous)) extras.push(previous);
      if (row.character_id) require('../utils/seedance2AssetGuards').markStaleOnCharacterMainImageDrift(db, { warn() {}, info() {} }, old, row);
      db.prepare(`UPDATE ${table} SET image_url = ?, local_path = ?, extra_images = ?, updated_at = ? WHERE id = ?`).run(row.image_url, row.local_path, JSON.stringify(extras), now, target);
    } else throw new Error('该图片没有关联人物、场景或分镜');
    updateMetadata(db, row.id, { result_usage: 'selected', selected_at: now });
    return { selected: true, image_generation_id: row.id };
  })();
}
module.exports = { FIELDS, metadataFields, requestOptions, config, saveConfig, prepare, record, references, run, cancel, resume, recover, adopt };
