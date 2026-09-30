const response = require('../response');
const models = require('../services/videoModelSelection');
const hybrid = require('../services/hybridVideoService');
const cost = require('../services/costEngine');
const comfy = require('../services/comfyVideoProvider');
function mount(router,db,log) {
  const route = fn=>async(req,res)=>{
    try { response.success(res,await fn(req)); }
    catch(err) { response.error(res,err.status || (err.message==='ComfyUI Offline' ? 503 : 400),'HYBRID_VIDEO_ERROR',err.message); }
  };
  router.get('/hybrid-video/models',route(()=>models.catalog(db)));
  router.get('/hybrid-video/state',route(req=>{
    const ep=db.prepare('SELECT drama_id,video_selection FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(req.query.episode_id));
    if (!ep) throw new Error('Episode 不存在');
    const project=db.prepare('SELECT default_video_selection FROM dramas WHERE id = ?').get(ep.drama_id);
    return {episode_selection:ep.video_selection,project_default:project?.default_video_selection,
      shots:db.prepare('SELECT id,video_provider,video_model,video_config_id,video_url FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(Number(req.query.episode_id))};
  }));
  router.get('/hybrid-video/settings',route(()=>({settings:cost.settings(db),prices:cost.prices(db),mapping:comfy.loadTemplate().mapping})));
  router.put('/hybrid-video/settings',route(req=>db.transaction(()=>({settings:cost.saveSettings(db,req.body.settings || {}),prices:req.body.prices ? cost.savePrices(db,req.body.prices) : cost.prices(db)}))()));
  router.post('/hybrid-video/connection',route(async()=>{const base=cost.settings(db).comfy_url; const status=await comfy.connection(base); await comfy.validateNodes(base); return status;}));
  router.get('/hybrid-video/queue',route(()=>comfy.request(cost.settings(db).comfy_url,'/queue')));
  router.get('/hybrid-video/history',route(req=>db.prepare('SELECT * FROM video_generations WHERE episode_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 200').all(Number(req.query.episode_id))));
  router.put('/hybrid-video/selection',route(req=>{models.select(db,req.body);return {saved:true};}));
  router.post('/hybrid-video/forecast',route(req=>hybrid.forecast(db,req.body).report));
  router.post('/hybrid-video/quote',route(req=>hybrid.quote(db,req.body)));
  router.get('/hybrid-video/shots/:id/prompt',route(req=>{
    const state=hybrid.promptState(db,req.params.id);
    return {intent:state.intent,mode:state.mode,prompt:state.shot.optimized_prompt || '',stale:state.stale,user_edited:!!state.shot.user_edited,
      generated_by_model:state.shot.generated_by_model,generated_at:state.shot.generated_at};
  }));
  router.post('/hybrid-video/shots/:id/optimize',route(req=>hybrid.optimize(db,log,req.params.id,req.body)));
  router.put('/hybrid-video/shots/:id/prompt',route(req=>hybrid.editPrompt(db,req.params.id,req.body)));
  router.post('/hybrid-video/shots/:id/static',route(req=>hybrid.keepStatic(db,req.params.id)));
  router.post('/hybrid-video/generations/:id/cancel',route(async req=>{await hybrid.cancel(db,req.params.id);return {cancelled:true};}));
}
module.exports = { mount };
