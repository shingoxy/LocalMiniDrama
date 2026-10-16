const aiConfigs = require('./aiConfigService');
const { parseMetadata } = require('./storageLayout');
const ImageRequestError = require('./imageRequestError');
const PURPOSES = ['character', 'scene', 'prop', 'first', 'last', 'image'];
const LOCAL = [
  { key: 'local:qwen-image-2.1', model: 'qwen-image-2.1', label: '本地 Qwen-Image 2.1', local: true, references: 6, modes: ['t2i', 'edit'] },
].map(m => ({ ...m, provider: 'local_comfyui' }));
function purpose(body) {
  if (body.character_id) return 'character';
  if (body.prop_id) return 'prop';
  if (body.scene_id && !body.storyboard_id) return 'scene';
  if (/^(last|storyboard_last|tail|last_frame)$/.test(body.frame_type || '')) return 'last';
  return body.storyboard_id ? 'first' : 'image';
}
function projectId(db, body) {
  let id = Number(body.drama_id) || 0;
  for (const [field, table] of [['storyboard_id', 'storyboards'], ['character_id', 'characters'], ['scene_id', 'scenes'], ['prop_id', 'props']]) {
    if (!body[field]) continue;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(Number(body[field]));
    if (!row) throw new ImageRequestError('图片目标素材不存在');
    const owner = field === 'storyboard_id' ? db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(row.episode_id)?.drama_id : row.drama_id;
    if (!owner || (id && id !== Number(owner))) throw new ImageRequestError('图片目标不属于该项目');
    id = Number(owner);
  }
  if (id && !db.prepare('SELECT id FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id)) throw new ImageRequestError('图片项目不存在');
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
  const fallback = Object.fromEntries(PURPOSES.map(use => [use, LOCAL[0].key]));
  if (!id) return fallback;
  const row = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw new ImageRequestError('项目不存在');
  const saved = parseMetadata(row.metadata).image_model_defaults || {};
  return Object.fromEntries(PURPOSES.map(use => {
    const key = saved[use] || (use === 'prop' ? saved.image : null);
    return [use, key && key !== 'auto' ? key : fallback[use]];
  }));
}
function resolve(db, body) {
  const id = projectId(db, body), use = purpose(body);
  const explicit = body.image_model_key;
  const saved = defaults(db, id);
  // Legacy model pickers also count as an explicit choice; configured cloud defaults do not.
  const requested = body.model && catalog(db, use).find(m => m.model === body.model);
  if ((!explicit || explicit === 'auto') && body.model && !requested) throw new ImageRequestError('图片模型已停用或未配置，请重新选择；不会自动替换模型');
  const key = explicit && explicit !== 'auto' ? explicit : requested?.key || saved[use];
  if (key === 'local:flux1-dev') throw new ImageRequestError('Flux 本地生图已移除，请选择 Qwen-Image 2.1');
  const found = catalog(db, use).find(m => m.key === key);
  if (!found) throw new ImageRequestError('图片模型已停用或未配置，请重新选择；不会自动替换模型');
  return found;
}
function select(db, body) {
  const use = body.purpose;
  if (!PURPOSES.includes(use)) throw new ImageRequestError('图片用途无效');
  if (body.key !== 'auto' && !catalog(db, use).some(m => m.key === body.key)) throw new ImageRequestError('图片模型不可用');
  const id = projectId(db, { drama_id: body.drama_id });
  if (!id) throw new ImageRequestError('请先创建项目');
  db.transaction(() => {
    const row = db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(id);
    const metadata = parseMetadata(row.metadata);
    metadata.image_model_defaults = { ...metadata.image_model_defaults, [use]: body.key };
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), new Date().toISOString(), id);
  })();
  return defaults(db, id);
}
module.exports = { LOCAL, PURPOSES, purpose, projectId, catalog, defaults, resolve, select };
