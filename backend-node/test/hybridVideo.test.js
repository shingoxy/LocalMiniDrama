const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const models = require('../src/services/videoModelSelection');
const costs = require('../src/services/costEngine');
const hybrid = require('../src/services/hybridVideoService');
const comfy = require('../src/services/comfyVideoProvider');
const h3 = require('../src/services/videoPromptAdapters/minimaxH3');
const log = { info(){},warn(){},error(){},debug(){} };
function migrate(db) {
  const old = console.log; console.log=()=>{};
  try { require('../src/db/migrate').runMigrationsAndEnsure(db); } finally {console.log=old;}
}
function fixture(t) {
  const db = new Database(':memory:');migrate(db);t.after(()=>db.close());
  db.prepare("INSERT INTO dramas(id,title) VALUES(1,'Existing drama')").run();
  db.prepare('INSERT INTO episodes(id,drama_id,episode_number) VALUES(1,1,1)').run();
  for (const id of [1,2,3]) db.prepare("INSERT INTO storyboards(id,episode_id,duration,video_prompt,action,dialogue) VALUES(?,1,5,'A person opens a letter.','Open a letter','Hello.')").run(id);
  for (const [id,provider,model] of [[1,'volces','seedance-fast'],[2,'kling','kling-v1'],[3,'deepseek','deepseek-test']]) db.prepare('INSERT INTO ai_service_configs(id,service_type,provider,model,default_model,is_active,is_default) VALUES(?,?,?,?,?,1,1)')
    .run(id,id===3 ? 'text' : 'video',provider,JSON.stringify([model]),model);
  const cloud=models.catalog(db).find(m=>m.model==='seedance-fast');
  return {db,cloud};
}
const validPrompt=()=>h3.alignment('I2VA',5)+'\n\nintegrated_multimodal_description: [Shot 1] The person opens a letter.\n\noverall_soundscape: Paper rustles.\n\nnon_diegetic_music: N/A';
test('migration preserves old storyboard data and is idempotent',t=>{
  const {db}=fixture(t);migrate(db);assert.equal(db.prepare('SELECT video_prompt FROM storyboards WHERE id=1').get().video_prompt,'A person opens a letter.');
  assert.equal(db.prepare('SELECT actual_cost FROM video_generations').all().length,0);
});
test('shot overrides episode and project; all-shot action clears overrides',t=>{
  const {db,cloud}=fixture(t);
  models.select(db,{scope:'project',drama_id:1,key:models.LOCAL.key});
  assert.equal(hybrid.prepare(db,{storyboard_id:1}).selection.local,true);
  models.select(db,{scope:'episode',episode_id:1,key:cloud.key});
  models.select(db,{scope:'shots',shot_ids:[1,2],key:models.LOCAL.key});
  assert.deepEqual([1,2,3].map(storyboard_id=>hybrid.prepare(db,{storyboard_id}).selection.local),[true,true,false]);
  models.select(db,{scope:'episode',episode_id:1,key:models.LOCAL.key});
  assert.deepEqual([1,2,3].map(storyboard_id=>hybrid.prepare(db,{storyboard_id}).selection.local),[true,true,true]);
});
test('batch selection is atomic and disabled explicit config never falls back',t=>{
  const {db,cloud}=fixture(t);
  assert.throws(()=>models.select(db,{scope:'shots',shot_ids:[1,999],key:cloud.key}));
  assert.equal(db.prepare('SELECT video_model FROM storyboards WHERE id=1').get().video_model,null);
  models.select(db,{scope:'shots',shot_ids:[1],key:cloud.key});
  db.prepare('UPDATE ai_service_configs SET is_active=0 WHERE id=1').run();
  assert.throws(()=>hybrid.prepare(db,{storyboard_id:1}),/停用|未配置/);
});
test('cloud requires explicit quote confirmation; consumed quotes cannot be replayed',async t=>{
  const {db}=fixture(t);const body={storyboard_id:1,resolution:'720p'};
  await assert.rejects(hybrid.prepareSubmission(db,body),/确认/);
  const quote=hybrid.quote(db,{requests:[body]});
  assert.equal(quote.incomplete,true);
  await assert.rejects(hybrid.prepareSubmission(db,{...body,quote_token:quote.token}),/确认/);
  const result=await hybrid.prepareSubmission(db,{...body,quote_token:quote.token,cloud_confirmed:true});assert.equal(result.body.config_id,1);
  await assert.rejects(hybrid.prepareSubmission(db,{...body,quote_token:quote.token,cloud_confirmed:true}),/已提交/);
});
test('quotes are invalidated by duration, resolution, selection or price changes',async t=>{
  const {db}=fixture(t);const body={storyboard_id:1,resolution:'720p'};
  const q=hybrid.quote(db,{requests:[body]});
  await assert.rejects(hybrid.prepareSubmission(db,{...body,resolution:'1080p',quote_token:q.token,cloud_confirmed:true}),/变化/);
  costs.saveSettings(db,{retry_multiplier:1.5});
  await assert.rejects(hybrid.prepareSubmission(db,{...body,quote_token:q.token,cloud_confirmed:true}),/失效/);
});
test('hybrid forecast separates fixed allocation, variable API and retry budget',t=>{
  const {db,cloud}=fixture(t);
  models.select(db,{scope:'shots',shot_ids:[1,2],key:models.LOCAL.key});
  costs.savePrices(db,[{provider:cloud.provider,model:cloud.model,price:0.6,billing_type:'per_second',currency:'CNY',resolution:'*',effective_date:'2026-01-01'}]);
  costs.saveSettings(db,{retry_multiplier:1.5,expected_episodes_per_month:20,subscriptions:[{name:'Agent',monthly_fee:500,enabled:true,included_quota:null,overage_price:null}]});
  const r=hybrid.forecast(db,{episode_id:1}).report;
  assert.equal(r.totals.CNY.variable_api,3);assert.equal(r.totals.CNY.subscription_allocation,25);
  assert.equal(r.totals.CNY.base_total,28);assert.equal(r.totals.CNY.risk_adjusted_budget,29.5);
  assert.match(r.warnings[0],/不能视为无限/);
  assert.equal(hybrid.forecast(db,{episode_id:1,episodes:30}).report.totals.CNY.base_total,840);
});
test('local time uses measured generation speed; electricity remains unknown without history',t=>{
  const {db}=fixture(t);
  const s=costs.saveSettings(db,{electricity:{enabled:true,power_w:300,price_per_kwh:1}});
  assert.equal(costs.estimateShot(db,models.LOCAL,5,null,s).electricity_cost,null);
  db.prepare("INSERT INTO video_generations(provider,model,status,output_duration,elapsed_seconds,generation_elapsed_seconds) VALUES('local_comfyui','minimax-h3','completed',5,900,420)").run();
  const r=costs.estimateShot(db,models.LOCAL,5,null,s);
  assert.equal(r.api_cost,0);assert.equal(r.estimated_compute_seconds,420);assert.ok(Math.abs(r.electricity_cost-0.035)<1e-9);
});
test('unknown prices remain null; actual bill is never fabricated from estimate',t=>{
  const {db,cloud}=fixture(t);assert.equal(costs.estimateShot(db,cloud,5,'720p').api_cost,null);
  const id=Number(db.prepare("INSERT INTO video_generations(provider,status,started_at,estimated_cost) VALUES('kling','completed',?,12)").run(new Date().toISOString()).lastInsertRowid);
  costs.finishRecord(db,id);const r=db.prepare('SELECT * FROM video_generations WHERE id=?').get(id);
  assert.equal(r.calculated_cost,12);assert.equal(r.actual_cost,null);
});
test('DeepSeek adapter selects a pinned config and caches output',async t=>{
  const {db}=fixture(t);let calls=0;
  t.mock.method(require('../src/services/aiClient'),'generateText',async(db,log,type,prompt,system,options)=>{
    calls++;assert.equal(options.config_id,3);assert.match(system,/Do not rewrite the story/);return validPrompt();
  });
  const a=await hybrid.optimize(db,log,1);assert.equal(a.cached,false);
  assert.equal((await hybrid.optimize(db,log,1)).cached,true);assert.equal(calls,1);
  hybrid.editPrompt(db,1,{optimized_prompt:validPrompt().replace('letter.','envelope.')});
  db.prepare("UPDATE storyboards SET action='Sit down' WHERE id=1").run();
  const edited=await hybrid.optimize(db,log,1);assert.equal(edited.shot.user_edited,1);assert.equal(calls,1);assert.equal(edited.stale,true);
});
test('concurrent manual edit is protected while DeepSeek is running',async t=>{
  const {db}=fixture(t);
  t.mock.method(require('../src/services/aiClient'),'generateText',async()=>{hybrid.editPrompt(db,1,{optimized_prompt:validPrompt()});return validPrompt();});
  await assert.rejects(hybrid.optimize(db,log,1,{force:true}),/手工 Prompt 已变化/);
  assert.equal(db.prepare('SELECT user_edited FROM storyboards WHERE id=1').get().user_edited,1);
});
test('H3 mapping preserves original math, samplers and loader settings; rejects unsupported inputs',()=>{
  const {workflow,mapping}=comfy.loadTemplate();const bound=comfy.bindWorkflow({prompt:validPrompt(),image:'shot.png',duration:5,seed:42});
  assert.equal(bound.workflow[mapping.fields.prompt.node].inputs.prompt,validPrompt());
  assert.equal(bound.workflow[mapping.fields.seed.node].inputs.noise_seed,42);
  assert.deepEqual(bound.workflow['105_9'],workflow['105_9']);assert.deepEqual(bound.workflow['105_107'],workflow['105_107']);
  assert.equal(bound.workflow['105_104'].inputs.first_frame[0],'119');
  assert.throws(()=>comfy.bindWorkflow({duration:5,last_frame:'a.png'}),/未连接/);
  assert.throws(()=>comfy.bindWorkflow({duration:5,fps:30}),/24 FPS/);
});
test('ComfyUI submit, queue, history, MP4 retrieval and cancellation use local protocol',async t=>{
  let submitted=null,deleted=null;
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const b of req)body+=b;
    res.setHeader('content-type','application/json');
    if(req.url==='/prompt'){submitted=JSON.parse(body);res.end(JSON.stringify({prompt_id:'job',node_errors:{}}));}
    else if(req.url==='/history/job')res.end(JSON.stringify({job:{outputs:{92:{images:[{filename:'video.mp4',type:'output'}]}},status:{completed:true,status_str:'success'}}}));
    else if(req.url==='/queue' && req.method==='POST'){deleted=JSON.parse(body);res.end('{}');}
    else if(req.url==='/queue')res.end(JSON.stringify({queue_pending:[[1,'job']],queue_running:[]}));
    else if(req.url.startsWith('/view')){res.setHeader('content-type','video/mp4');res.end(Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom00000000')]));}
    else {res.statusCode=404;res.end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  await comfy.request(base,'/prompt',{prompt:comfy.loadTemplate().workflow});assert.ok(submitted.prompt);
  const result=await comfy.waitForOutput(base,'job',comfy.loadTemplate().mapping,{poll_interval_ms:1});assert.equal(result.output.filename,'video.mp4');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lmd-h3-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  await comfy.download(base,result.output,path.join(root,'video.mp4'));assert.ok(fs.statSync(path.join(root,'video.mp4')).size>16);
  await comfy.cancel(base,'job');assert.deepEqual(deleted,{delete:['job']});
  assert.throws(()=>comfy.localImage('../secret.png',root),/不在 Media Library/);
});
test('local failure does not call any paid cloud provider',async t=>{
  const {db}=fixture(t);let cloud=0;
  t.mock.method(comfy,'connection',async()=>{throw new Error('ComfyUI Offline');});
  t.mock.method(require('../src/services/videoClient'),'callVideoApi',async()=>{cloud++;throw Error('Unexpected paid call');});
  const id=Number(db.prepare("INSERT INTO video_generations(provider,storyboard_id,drama_id,model,duration,status,started_at) VALUES('local_comfyui',1,1,'minimax-h3',5,'processing',?)").run(new Date().toISOString()).lastInsertRowid);
  await require('../src/services/videoService').processVideoGeneration(db,log,id);
  assert.equal(cloud,0);assert.equal(db.prepare('SELECT status,error_msg FROM video_generations WHERE id=?').get(id).status,'failed');
});
test('price schedules, monthly allocation and local compute hourly rates are honored',t=>{
  const {db,cloud}=fixture(t);
  costs.savePrices(db,[{provider:cloud.provider,model:cloud.model,billing_type:'monthly_subscription',price:500,currency:'CNY',resolution:'*',effective_date:'2026-01-01'},
    {provider:cloud.provider,model:cloud.model,billing_type:'per_second',price:99,currency:'CNY',resolution:'720p',effective_date:'2099-01-01'},
    {provider:models.LOCAL.provider,model:models.LOCAL.model,billing_type:'local_compute',price:3,currency:'CNY',resolution:'*',effective_date:'2026-01-01'}]);
  const r=hybrid.forecast(db,{requests:[{storyboard_id:1,resolution:'720p'}]}).report;
  assert.equal(r.totals.CNY.variable_api,0);assert.equal(r.totals.CNY.subscription_allocation,25);
  db.prepare("INSERT INTO video_generations(provider,status,generation_elapsed_seconds,output_duration) VALUES('local_comfyui','completed',3600,5)").run();
  assert.equal(costs.estimateShot(db,models.LOCAL,5,null).local_compute_cost,3);
});
test('mixed generation dispatches to pinned cloud configs and local provider independently',async t=>{
  const {db,cloud}=fixture(t);const calls=[];
  models.select(db,{scope:'shots',shot_ids:[1],key:models.LOCAL.key});
  models.select(db,{scope:'shots',shot_ids:[2],key:cloud.key});
  models.select(db,{scope:'shots',shot_ids:[3],key:models.catalog(db).find(m=>m.model==='kling-v1').key});
  t.mock.method(comfy,'connection',async()=>({online:true}));
  t.mock.method(hybrid,'runLocal',async(db,log,id)=>{calls.push('local');db.prepare("UPDATE video_generations SET status='failed' WHERE id=?").run(id);});
  t.mock.method(require('../src/services/videoClient'),'callVideoApi',async(db,log,options)=>{calls.push(options.config_id);return {error:'Mock cloud failure'};});
  const bodies=[1,2,3].map(storyboard_id=>({storyboard_id,drama_id:1,prompt:'Director prompt'}));
  const q=hybrid.quote(db,{requests:bodies});
  for (const body of bodies) {
    const p=await hybrid.prepareSubmission(db,{...body,quote_token:q.token,cloud_confirmed:true});
    const id=Number(db.prepare("INSERT INTO video_generations(storyboard_id,drama_id,provider,model,duration,prompt,status) VALUES(?,1,?,?,5,?,'processing')")
      .run(body.storyboard_id,p.body.provider,p.body.model,p.body.prompt).lastInsertRowid);
    hybrid.recordSubmission(db,id,p.prepared,p.body);
    await require('../src/services/videoService').processVideoGeneration(db,log,id);
  }
  assert.deepEqual(calls,['local',1,2]);
  assert.deepEqual(db.prepare('SELECT provider FROM video_generations ORDER BY id').all().map(r=>r.provider),['local_comfyui','volces','kling']);
});
test('cloud confirmation guard runs before any generation or task is inserted',async t=>{
  const {db}=fixture(t);let result,status;
  const res={status(n){status=n;return this;},json(v){result=v;}};
  await require('../src/routes/videos')(db,log).create({body:{storyboard_id:1,drama_id:1}},res);
  assert.equal(status,409);assert.equal(result.success,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM video_generations').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM async_tasks').get().n,0);
});
test('FFmpeg compose resolves H3 clip URL while preserving storyboard reference image path',async t=>{
  const {db}=fixture(t);let mergeRequest;
  db.prepare("UPDATE storyboards SET video_url='/static/projects/h3.mp4',local_path='projects/reference.png',updated_at='2026-09-30T00:00:00Z' WHERE id=1").run();
  db.prepare('UPDATE storyboards SET deleted_at=? WHERE id IN(2,3)').run(new Date().toISOString());
  const service=require('../src/services/videoMergeService');
  t.mock.method(service,'create',(db,log,body)=>{mergeRequest=body;return {id:99,task_id:'mock'};});
  t.mock.method(service,'processVideoMerge',async()=>{});
  require('../src/services/dramaService').finalizeEpisode(db,log,1,'http://127.0.0.1:5679/static');
  await new Promise(setImmediate);
  assert.equal(mergeRequest.scenes[0].video_url,'http://127.0.0.1:5679/static/projects/h3.mp4');
  assert.equal(db.prepare('SELECT local_path FROM storyboards WHERE id=1').get().local_path,'projects/reference.png');
});
