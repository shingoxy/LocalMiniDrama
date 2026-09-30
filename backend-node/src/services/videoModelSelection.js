const aiConfigs = require('./aiConfigService');
const LOCAL = { key: 'local:minimax-h3', provider: 'local_comfyui', model: 'minimax-h3', config_id: null, label: 'Local MiniMax H3', local: true };
function json(value, fallback = {}) { try { return typeof value === 'string' ? JSON.parse(value) : value || fallback; } catch { return fallback; } }
function catalog(db) {
  const models = [LOCAL];
  for (const c of aiConfigs.listConfigs(db, 'video').filter(c => c.is_active)) {
    for (const model of Array.isArray(c.model) ? c.model : [c.model]) {
      if (!model) continue;
      models.push({ key: `cloud:${c.id}:${encodeURIComponent(model)}`, provider: c.provider, model,
        config_id: c.id, api_protocol: c.api_protocol, default_model: model, label: `${model} · ${c.name}`, local: false });
    }
  }
  return models;
}
function fromKey(db, key) {
  const found = catalog(db).find(m => m.key === key);
  if (!found) throw new Error('视频模型已停用或未配置，请在 AI 配置中启用对应模型');
  return found;
}
function context(db, body) {
  let shot = null, episode = null, project = null;
  if (body.storyboard_id) {
    shot = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(body.storyboard_id));
    if (!shot) throw new Error('Shot 不存在');
    episode = db.prepare('SELECT * FROM episodes WHERE id = ? AND deleted_at IS NULL').get(shot.episode_id);
    if (!episode) throw new Error('Episode 不存在');
    if (body.drama_id && Number(body.drama_id) !== episode.drama_id) throw new Error('Shot 不属于该项目');
  }
  const id = episode?.drama_id || Number(body.drama_id);
  if (id) project = db.prepare('SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id);
  return { shot, episode, project };
}
function resolve(db, body, ctx = context(db, body)) {
  // Local Draft is an explicit, temporary local request; it never selects a paid model.
  if (body.local_draft === true) return LOCAL;
  const { shot, episode, project } = ctx;
  if (shot?.video_model) {
    return fromKey(db, shot.video_provider === LOCAL.provider ? LOCAL.key
      : `cloud:${shot.video_config_id}:${encodeURIComponent(shot.video_model)}`);
  }
  if (episode?.video_selection) return fromKey(db, episode.video_selection);
  if (project?.default_video_selection) return fromKey(db, project.default_video_selection);
  const models = catalog(db);
  if (body.model) {
    const selected = models.find(m => m.model === body.model && (!body.config_id || m.config_id === Number(body.config_id)));
    if (!selected) throw new Error('请求的视频模型未配置，禁止自动替换');
    return selected;
  }
  const c = aiConfigs.listConfigs(db, 'video').find(c => c.is_active && c.is_default)
    || aiConfigs.listConfigs(db, 'video').find(c => c.is_active);
  if (!c) throw new Error('请设置 Project Default Video Model 或配置云视频模型');
  return models.find(m => m.config_id === c.id && m.model === (c.default_model || c.model?.[0]));
}
function select(db, body) {
  const { scope, key } = body;
  const selected = key && key !== 'auto' ? fromKey(db, key) : null;
  db.transaction(() => {
    if (scope === 'project') {
      const r = db.prepare('UPDATE dramas SET default_video_selection = ? WHERE id = ? AND deleted_at IS NULL').run(selected?.key || null, Number(body.drama_id));
      if (!r.changes) throw new Error('Project 不存在');
    } else if (scope === 'episode') {
      const r = db.prepare('UPDATE episodes SET video_selection = ? WHERE id = ? AND deleted_at IS NULL').run(selected?.key || null, Number(body.episode_id));
      if (!r.changes) throw new Error('Episode 不存在');
      // The all-shots action explicitly replaces previous shot overrides.
      db.prepare('UPDATE storyboards SET video_provider = NULL, video_model = NULL, video_config_id = NULL WHERE episode_id = ? AND deleted_at IS NULL').run(Number(body.episode_id));
    } else if (scope === 'shots') {
      const ids = [...new Set(body.shot_ids || [])];
      if (!ids.length || ids.length > 500) throw new Error('请选择 1–500 个 Shot');
      for (const id of ids) {
        const r = db.prepare('UPDATE storyboards SET video_provider = ?, video_model = ?, video_config_id = ? WHERE id = ? AND deleted_at IS NULL')
          .run(selected?.provider || null, selected?.model || null, selected?.config_id || null, Number(id));
        if (!r.changes) throw new Error('Shot 不存在: ' + id);
      }
    } else throw new Error('未知的模型选择范围');
  })();
}
module.exports = { LOCAL, json, catalog, fromKey, context, resolve, select };
