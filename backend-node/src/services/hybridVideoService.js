const { randomUUID, createHash } = require('crypto');
const path = require('path');
const models = require('./videoModelSelection');
const intents = require('./shotIntent');
const cost = require('./costEngine');
const comfy = require('./comfyVideoProvider');
const h3 = require('./videoPromptAdapters/minimaxH3');
const adapters = require('./videoPromptAdapters');
const tasks = require('./taskService');
function prepare(db, body) {
  const ctx = models.context(db,body);
  const selection = models.resolve(db,body,ctx);
  if (!selection) throw new Error('默认视频模型无效');
  const duration = Number(ctx.shot?.duration || body.duration || 5);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw new Error('视频时长无效');
  const resolution = selection.local ? body.width && body.height ? `${body.width}x${body.height}` : 'workflow:auto' : body.resolution || null;
  const intent = intents.build(db,ctx.shot || {},{ ...body,duration });
  const fingerprint = createHash('sha256').update(JSON.stringify({
    storyboard_id: ctx.shot?.id || null, drama_id: ctx.project?.id || null,
    selection: selection.key, duration, resolution,
    intent: intents.hash(intents.build(db,ctx.shot || {},{duration}),selection.local ? comfy.loadTemplate().mapping.mode : 'cloud'),
    free_prompt: ctx.shot ? null : body.prompt,
  })).digest('hex');
  return { ctx, selection, duration, resolution, intent, fingerprint,
    estimate: cost.estimateShot(db,selection,duration,resolution) };
}
function forecast(db, body) {
  let requests = body.requests;
  if (!requests) {
    const boards = db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number,id').all(Number(body.episode_id));
    const ids = body.shot_ids ? new Set(body.shot_ids.map(Number)) : null;
    requests = boards.filter(b=>!ids || ids.has(b.id)).map(b=>({storyboard_id:b.id,resolution:body.resolution,local_draft:body.local_draft}));
  }
  if (!Array.isArray(requests) || !requests.length || requests.length>500) throw new Error('请选择 1–500 个 Shot');
  const prepared = requests.map(r=>prepare(db,r));
  if (new Set(prepared.map(p=>p.fingerprint)).size !== prepared.length) throw new Error('预测请求包含重复 Shot');
  const episodes = Number(body.episodes || 1);
  if (!Number.isInteger(episodes) || episodes<1 || episodes>1000) throw new Error('集数必须在 1–1000');
  return { prepared, report: cost.summarize(db,prepared.map(p=>({ ...p.estimate, storyboard_id:p.ctx.shot?.id })),cost.settings(db),episodes) };
}
function quote(db,body) {
  const { prepared,report } = forecast(db,{...body,episodes:1});
  const token = randomUUID();
  const now = new Date().toISOString();
  db.prepare('DELETE FROM video_cost_quotes WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO video_cost_quotes(token,requests_json,settings_hash,expires_at) VALUES(?,?,?,?)')
    .run(token,JSON.stringify(prepared.map(p=>p.fingerprint)),cost.settingsHash(db),new Date(Date.now()+24*60*60000).toISOString());
  return { ...report,token };
}
function consumeQuote(db,body,p) {
  if (p.selection.local) return;
  if (body.cloud_confirmed !== true || !body.quote_token) throw Object.assign(new Error('包含收费云模型：请先查看成本预测并明确确认'),{status:409});
  db.transaction(()=>{
    const q = db.prepare('SELECT * FROM video_cost_quotes WHERE token = ? AND expires_at > ?').get(body.quote_token,new Date().toISOString());
    if (!q || q.settings_hash!==cost.settingsHash(db)) throw Object.assign(new Error('费用预测已失效，请重新预测并确认'),{status:409});
    const claims = JSON.parse(q.requests_json), consumed = JSON.parse(q.consumed_json);
    if (!claims.includes(p.fingerprint) || consumed.includes(p.fingerprint)) throw Object.assign(new Error('Shot、模型、时长或价格已变化，或该生成已提交，请重新确认'),{status:409});
    consumed.push(p.fingerprint);
    db.prepare('UPDATE video_cost_quotes SET consumed_json = ? WHERE token = ?').run(JSON.stringify(consumed),body.quote_token);
  })();
}
async function prepareSubmission(db,body) {
  const p = prepare(db,body);
  if (p.selection.local) {
    if (p.duration < 4 || p.duration > 15) throw new Error('当前 H3 Workflow 支持 4–15 秒，请调整该 Shot 的时长');
    if (body.last_frame_url || body.last_frame_local_path || body.audio) throw new Error('当前 H3 Workflow 未连接尾帧/外部音频');
    await comfy.connection(cost.settings(db).comfy_url);
  }
  consumeQuote(db,body,p);
  return { prepared:p, body:{ ...body, provider:p.selection.provider, model:p.selection.model, config_id:p.selection.config_id,
    duration:p.duration, resolution:p.resolution, drama_id:p.ctx.project?.id || body.drama_id,
    prompt:p.selection.local ? body.prompt || p.intent.original_prompt : adapters.cloudPrompt(p.selection.model,p.intent,body.prompt) } };
}
function recordSubmission(db,id,p,body) {
  const now = new Date().toISOString();
  const retries = p.ctx.shot ? db.prepare('SELECT COUNT(*) n FROM video_generations WHERE storyboard_id = ? AND id <> ? AND deleted_at IS NULL').get(p.ctx.shot.id,id).n : 0;
  db.prepare('UPDATE video_generations SET config_id = ?, episode_id = ?, started_at = ?, estimated_cost = ?, retry_count = ?, cost_metadata = ?, generation_metadata = ? WHERE id = ?')
    .run(p.selection.config_id,p.ctx.episode?.id || null,now,p.estimate.api_cost,retries,JSON.stringify(p.estimate),
      JSON.stringify({ selection:p.selection.key, resolution_key:p.resolution, local_draft:body.local_draft===true, input:{ width:body.width,height:body.height,fps:body.fps }, intent:p.intent }),id);
}
function promptState(db,id,body={}) {
  const shot = models.context(db,{storyboard_id:id}).shot;
  const { mapping } = comfy.loadTemplate();
  const mode = body.h3_mode || mapping.mode;
  const intent = intents.build(db,shot,body);
  const sourceHash = intents.hash(intent,mode);
  return { shot,intent,mode,sourceHash, mapping, stale:shot.source_prompt_hash!==sourceHash || shot.h3_mode!==mode };
}
async function optimize(db,log,id,body={}) {
  const state = promptState(db,id,body);
  const { shot,intent,mode,sourceHash } = state;
  if (!state.mapping.supported_modes.includes(mode)) throw new Error('当前 Workflow 未连接该 H3 Mode');
  if (shot.user_edited && shot.h3_mode !== mode && !body.force) throw new Error('手工 Prompt 的 H3 Mode 已变化，请手动更新或明确重新优化');
  if (shot.optimized_prompt && (shot.user_edited || !state.stale) && !body.force) return { ...state,cached:true,prompt:shot.optimized_prompt };
  const configs = require('./aiConfigService').listConfigs(db,'text').filter(c=>c.is_active && /deepseek/i.test(c.provider + ' ' + c.model));
  const config = configs.find(c=>c.is_default) || configs[0];
  if (!config) throw new Error('请在 AI 配置中启用 DeepSeek 文本模型以优化 H3 Prompt');
  const model = config.default_model || config.model?.[0];
  const output = await require('./aiClient').generateText(db,log,'text',JSON.stringify(intent),h3.systemPrompt(mode,intent.duration),
    { model,config_id:config.id,temperature:0.3,max_tokens:2000 });
  const prompt = h3.validate(typeof output==='string' ? output : output?.text,mode,intent.duration);
  // An edit or intent change during an LLM request must never be overwritten.
  const current = promptState(db,id,body);
  if (current.sourceHash!==sourceHash || current.shot.optimized_prompt!==shot.optimized_prompt || current.shot.user_edited!==shot.user_edited) throw new Error('优化期间 Shot 或手工 Prompt 已变化，请重新检查');
  const now = new Date().toISOString();
  db.prepare('UPDATE storyboards SET source_prompt_hash = ?, h3_mode = ?, optimized_prompt = ?, provider_prompt = ?, prompt_version = ?, generated_by_model = ?, generated_at = ?, user_edited = 0 WHERE id = ?')
    .run(sourceHash,mode,prompt,prompt,h3.VERSION,model,now,Number(id));
  return { intent,mode,prompt,cached:false,stale:false,user_edited:false,generated_by_model:model,generated_at:now };
}
function editPrompt(db,id,body) {
  const state = promptState(db,id);
  if (body.shot_intent !== undefined) {
    if (!body.shot_intent || typeof body.shot_intent !== 'object' || Array.isArray(body.shot_intent)) throw new Error('Shot Intent 必须是 JSON 对象');
    db.prepare('UPDATE storyboards SET shot_intent = ? WHERE id = ?').run(JSON.stringify(body.shot_intent),Number(id));
  }
  if (body.optimized_prompt !== undefined) {
    const prompt = h3.validate(body.optimized_prompt,state.mode,state.intent.duration);
    db.prepare('UPDATE storyboards SET optimized_prompt = ?, provider_prompt = ?, user_edited = 1, h3_mode = ?, prompt_version = ?, source_prompt_hash = ? WHERE id = ?')
      .run(prompt,prompt,state.mode,h3.VERSION,state.sourceHash,Number(id));
  }
  const current = promptState(db,id);
  return {intent:current.intent,mode:current.mode,prompt:current.shot.optimized_prompt,stale:current.stale,user_edited:!!current.shot.user_edited};
}
async function runLocal(db,log,id,resume=false) {
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(Number(id));
  if (!row || row.status!=='processing') return;
  const s = cost.settings(db), meta = models.json(row.generation_metadata);
  const address = meta.comfy_url || s.comfy_url;
  const { mapping } = comfy.loadTemplate();
  let promptId = resume ? row.provider_task_id : null;
  let stopProgress = null, sampling = null;
  try {
    if (!promptId) {
      if (!row.storyboard_id) throw new Error('本地 H3 需要关联 Shot');
      await comfy.connection(address);
      const optimized = await optimize(db,log,row.storyboard_id,{duration:row.duration,first_frame_url:row.first_frame_url || row.image_url});
      const cfg = require('../config').loadConfig();
      const root = path.resolve(cfg.storage.local_path || './data/storage');
      const intent = meta.intent || optimized.intent;
      const image = await comfy.upload(address,comfy.localImage(row.first_frame_url || row.image_url || intent.reference_image,root));
      const bound = comfy.bindWorkflow({ ...meta.input,prompt:optimized.prompt,image,duration:row.duration,seed:row.seed,last_frame:row.last_frame_url });
      meta.client_id = randomUUID();
      stopProgress = comfy.watchProgress(address,meta.client_id,()=>promptId,progress=>{sampling=progress;});
      const response = await comfy.request(address,'/prompt',{prompt:bound.workflow,client_id:meta.client_id});
      if (!response.prompt_id || Object.keys(response.node_errors || {}).length) throw new Error('H3 Workflow 提交失败: '+JSON.stringify(response.node_errors || response));
      promptId = response.prompt_id;
      meta.comfy_url = address; meta.h3_mode = mapping.mode; meta.prompt_version = h3.VERSION;
      const seed=bound.workflow[mapping.fields.seed.node].inputs[mapping.fields.seed.input];
      db.prepare('UPDATE video_generations SET provider_task_id = ?, prompt = ?, generation_metadata = ?, seed = ? WHERE id = ?').run(promptId,optimized.prompt,JSON.stringify(meta),seed,id);
    }
    if (!stopProgress && meta.client_id) stopProgress = comfy.watchProgress(address,meta.client_id,()=>promptId,progress=>{sampling=progress;});
    const result = await comfy.waitForOutput(address,promptId,mapping,{timeout_minutes:s.local_timeout_minutes,
      isCancelled:()=>db.prepare('SELECT status FROM video_generations WHERE id = ?').get(id)?.status==='cancelled',
      onProgress:progress=>{
        const value = sampling?.max > 0 ? Math.min(90,10+80*sampling.value/sampling.max) : progress.status==='running' ? 10 : 5;
        const message = progress.status==='running' ? sampling?.max ? `MiniMax H3 Sampling ${sampling.value}/${sampling.max}` : 'MiniMax H3 正在执行节点' : `ComfyUI Queue: ${progress.queue_position}`;
        if (row.task_id) tasks.updateTaskStatus(db,row.task_id,'processing',value,message);
      } });
    const cfg = require('../config').loadConfig();
    const root = path.resolve(cfg.storage.local_path || './data/storage');
    const subdir = require('./storageLayout').getProjectStorageSubdir(db,row.drama_id);
    const localPath = path.join(subdir || 'library','videos',`h3_${id}.mp4`).replace(/\\/g,'/');
    const destination = path.join(root,localPath);
    await comfy.download(address,result.output,destination);
    const outputDuration = comfy.probeDuration(destination);
    const url = '/static/' + localPath;
    const now = new Date().toISOString();
    const runtime = result.history.status?.messages || [];
    const started = runtime.find(m=>m[0]==='execution_start')?.[1]?.timestamp;
    const completed = runtime.find(m=>m[0]==='execution_success')?.[1]?.timestamp;
    meta.generation_elapsed_seconds = started && completed ? (completed-started)/1000 : null;
    db.prepare("UPDATE video_generations SET status = 'completed', video_url = ?, local_path = ?, output_duration = ?, completed_at = ?, updated_at = ?, generation_metadata = ?, generation_elapsed_seconds = ? WHERE id = ? AND status = 'processing'")
      .run(url,localPath,outputDuration,now,now,JSON.stringify(meta),meta.generation_elapsed_seconds,id);
    if (db.prepare('SELECT status FROM video_generations WHERE id = ?').get(id).status==='cancelled') return;
    db.prepare('UPDATE storyboards SET video_url = ?, updated_at = ? WHERE id = ?').run(url,now,row.storyboard_id);
    if (row.task_id) tasks.updateTaskResult(db,row.task_id,{video_generation_id:id,video_url:url,status:'completed'});
  } catch (err) {
    const status = db.prepare('SELECT status FROM video_generations WHERE id = ?').get(id)?.status;
    if (status!=='cancelled') {
      const msg = err.message==='ComfyUI Offline' || err.message.startsWith('Local generation failed:') ? err.message : 'Local generation failed: '+err.message;
      const now = new Date().toISOString();
      db.prepare("UPDATE video_generations SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?").run(msg.slice(0,1000),now,id);
      if (row.task_id) tasks.updateTaskError(db,row.task_id,msg);
      log.error('Local H3 generation failed',{id,error:msg});
    }
  } finally { stopProgress?.(); cost.finishRecord(db,id); }
}
async function cancel(db,id) {
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row || row.provider!=='local_comfyui' || row.status!=='processing' || !row.provider_task_id) throw new Error('只能取消已提交的本地 ComfyUI 任务');
  await comfy.cancel(models.json(row.generation_metadata).comfy_url || cost.settings(db).comfy_url,row.provider_task_id);
  db.prepare("UPDATE video_generations SET status = 'cancelled', updated_at = ? WHERE id = ?").run(new Date().toISOString(),row.id);
  if (row.task_id) tasks.updateTaskError(db,row.task_id,'Local generation cancelled');
  cost.finishRecord(db,row.id);
}
async function keepStatic(db,id) {
  const ctx=models.context(db,{storyboard_id:id});
  const cfg=require('../config').loadConfig();
  const root=path.resolve(cfg.storage.local_path || './data/storage');
  const first=ctx.shot.first_frame_image_id ? db.prepare('SELECT local_path,image_url FROM image_generations WHERE id = ?').get(ctx.shot.first_frame_image_id) : null;
  const image=comfy.localImage(first?.local_path || first?.image_url || ctx.shot.composed_image || ctx.shot.image_url,root);
  const subdir=require('./storageLayout').getProjectStorageSubdir(db,ctx.project.id);
  const localPath=path.join(subdir,'videos',`static_${id}_${randomUUID()}.mp4`).replace(/\\/g,'/');
  const destination=path.join(root,localPath);
  require('fs').mkdirSync(path.dirname(destination),{recursive:true});
  const duration=Number(ctx.shot.duration)>0 ? Number(ctx.shot.duration) : 5;
  await new Promise((resolve,reject)=>{
    const child=require('child_process').spawn(require('../utils/ffmpegPath').getFfmpegPath(),['-y','-loop','1','-i',image,'-t',String(duration),'-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2','-r','24','-c:v','libx264','-pix_fmt','yuv420p',destination],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let error='';child.stderr.on('data',b=>{error=(error+b).slice(-1000);});
    child.on('error',reject);child.on('close',code=>code===0 ? resolve() : reject(new Error('Keep Static FFmpeg 失败: '+error)));
  });
  const url='/static/'+localPath,now=new Date().toISOString();
  db.prepare('UPDATE storyboards SET video_url = ?, updated_at = ? WHERE id = ?').run(url,now,Number(id));
  db.prepare("INSERT INTO video_generations(drama_id,episode_id,storyboard_id,provider,model,duration,output_duration,video_url,local_path,status,started_at,completed_at,created_at,updated_at,estimated_cost,calculated_cost,actual_cost) VALUES(?,?,?,'static','still-image',?,?,?,?,'completed',?,?,?,?,0,0,0)")
    .run(ctx.project.id,ctx.episode.id,Number(id),duration,comfy.probeDuration(destination),url,localPath,now,now,now,now);
  return {video_url:url};
}
module.exports = { prepare,forecast,quote,prepareSubmission,recordSubmission,promptState,optimize,editPrompt,runLocal,cancel,keepStatic };
