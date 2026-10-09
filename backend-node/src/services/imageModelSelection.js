const aiConfigs = require('./aiConfigService');
const { parseMetadata } = require('./storageLayout');
const PURPOSES = ['character', 'scene', 'first', 'last', 'image'];
const LOCAL = [
  { key: 'local:qwen-image-2.1', model: 'qwen-image-2.1', label: '本地 Qwen-Image 2.1', local: true, references: 6, modes: ['t2i', 'edit'] },
  { key: 'local:flux1-dev', model: 'flux1-dev', label: '本地 Flux.1-dev', local: true, references: 0, modes: ['t2i'] },
].map(m => ({ ...m, provider: 'local_comfyui' }));
function purpose(body) {
  if (body.character_id) return 'character';
  if (body.scene_id && !body.storyboard_id) return 'scene';
  if (/^(last|storyboard_last|tail|last_frame)$/.test(body.frame_type || '')) return 'last';
  return body.storyboard_id ? 'first' : 'image';
}
function projectId(db, body) {
  let id = Number(body.drama_id) || 0;
  for (const [field, table] of [['storyboard_id', 'storyboards'], ['character_id', 'characters'], ['scene_id', 'scenes']]) {
    if (!body[field]) continue;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(Number(body[field]));
    if (!row) throw new Error('图片目标素材不存在');
    const owner = field === 'storyboard_id' ? db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(row.episode_id)?.drama_id : row.drama_id;
    if (!owner || (id && id !== Number(owner))) throw new Error('图片目标不属于该项目');
    id = Number(owner);
  }
  if (id && !db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id)) throw new Error('图片项目不存在');
  return id;
}
function catalog(db, use = 'image') {
  const types = use === 'first' || use === 'last' ? ['storyboard_image', 'image'] : ['image'];
  const configs = types.flatMap(type => aiConfigs.listConfigs(db, type)).filter(c => c.is_active);
  return [...LOCAL, ...configs.flatMap(c => (Array.isArray(c.model) ? c.model : [c.model]).filter(Boolean).map(model => ({
    key: `cloud:${c.id}:${encodeURIComponent(model)}`, model, config_id: c.id, provider: c.provider, local: false, label: `${model} · ${c.name}`,
  })))];
}
function defaults(db, id) {
  if (!id) return {};
  const row = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw new Error('项目不存在');
  return parseMetadata(row.metadata).image_model_defaults || {};
}
function resolve(db, body) {
  // Old cloud-only callers can lack a project row (public library or imported legacy requests).
  // Enforce ownership for explicit selections and entity targets without changing that legacy path.
  if ((!body.image_model_key || body.image_model_key === 'auto') && body.drama_id && !body.storyboard_id && !body.character_id && !body.scene_id &&
      !db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(body.drama_id))) return null;
  const id = projectId(db, body), use = purpose(body);
  const explicit = body.image_model_key;
  const key = explicit && explicit !== 'auto' ? explicit : defaults(db, id)[use];
  if (!key || key === 'auto') return null; // Original cloud routing remains unchanged.
  const found = catalog(db, use).find(m => m.key === key);
  if (!found) throw new Error('图片模型已停用或未配置，请重新选择；不会自动替换模型');
  return found;
}
function select(db, body) {
  const use = body.purpose;
  if (!PURPOSES.includes(use)) throw new Error('图片用途无效');
  if (body.key !== 'auto' && !catalog(db, use).some(m => m.key === body.key)) throw new Error('图片模型不可用');
  const id = projectId(db, { drama_id: body.drama_id });
  if (!id) throw new Error('请先创建项目');
  db.transaction(() => {
    const row = db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(id);
    const metadata = parseMetadata(row.metadata);
    metadata.image_model_defaults = { ...metadata.image_model_defaults, [use]: body.key };
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), new Date().toISOString(), id);
  })();
  return defaults(db, id);
}
module.exports = { LOCAL, PURPOSES, purpose, projectId, catalog, defaults, resolve, select };
