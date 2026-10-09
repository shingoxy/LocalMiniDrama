const response = require('../response');
const models = require('../services/imageModelSelection');
const local = require('../services/localImageService');
const comfy = require('../services/comfyClient');
const provider = require('../services/comfyImageProvider');
const cost = require('../services/costEngine');
function mount(router, db, log) {
  const route = fn => async (req, res) => {
    try { response.success(res, await fn(req)); }
    catch (err) { response.error(res, err.message === 'ComfyUI Offline' ? 503 : 400, 'LOCAL_IMAGE_ERROR', err.message); }
  };
  router.get('/images/models', route(req => ({ models: models.catalog(db, req.query.purpose), defaults: models.defaults(db, Number(req.query.drama_id) || 0) })));
  router.put('/images/selection', route(req => models.select(db, req.body)));
  router.get('/images/local/settings', route(() => ({ ...local.config(db), comfy_url: cost.settings(db).comfy_url })));
  router.put('/images/local/settings', route(req => db.transaction(() => {
    if (req.body.comfy_url != null) cost.saveSettings(db, { comfy_url: req.body.comfy_url });
    return { ...local.saveConfig(db, req.body), comfy_url: cost.settings(db).comfy_url };
  })()));
  router.post('/images/local/connection', route(async () => {
    const base = cost.settings(db).comfy_url;
    await comfy.request(base, '/system_stats');
    const workflows = [];
    for (const key of provider.KEYS) {
      try { await provider.validate(base, provider.loadTemplate(key).workflow); workflows.push({ key, available: true }); }
      catch (err) { workflows.push({ key, available: false, error: err.message }); }
    }
    return { online: true, address: base, workflows };
  }));
  router.get('/images/local/queue', route(() => comfy.request(cost.settings(db).comfy_url, '/queue')));
  router.post('/images/:id/select', route(req => local.adopt(db, req.params.id, req.body)));
  router.post('/images/:id/cancel', route(async req => { await local.cancel(db, req.params.id); return { cancelled: true }; }));
  router.post('/images/:id/resume', route(req => local.resume(db, log, req.params.id)));
}
module.exports = { mount };
