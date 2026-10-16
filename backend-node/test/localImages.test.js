const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const models = require('../src/services/imageModelSelection');
const images = require('../src/services/imageService');
const client = require('../src/services/imageClient');
const local = require('../src/services/localImageService');
const provider = require('../src/services/comfyImageProvider');
const comfy = require('../src/services/comfyClient');
const costs = require('../src/services/costEngine');
const config = require('../src/config');
const log = { info() {}, warn() {}, error() {}, debug() {} };
function fixture(t) {
  const db = new Database(':memory:');
  const old = console.log; console.log = () => {};
  try { require('../src/db/migrate').runMigrationsAndEnsure(db); } finally { console.log = old; }
  db.prepare("INSERT INTO dramas(id,title,metadata) VALUES(1,'Test project','{}'),(2,'Other project','{}')").run();
  db.prepare('INSERT INTO episodes(id,drama_id,episode_number) VALUES(1,1,1)').run();
  db.prepare("INSERT INTO characters(id,drama_id,name,appearance) VALUES(1,1,'Person','A person'),(2,2,'Other','Other')").run();
  db.prepare("INSERT INTO scenes(id,drama_id,location) VALUES(1,1,'Room')").run();
  db.prepare("INSERT INTO storyboards(id,episode_id,storyboard_number,characters,scene_id,action,result,duration) VALUES(1,1,1,'[1]',1,'Open a letter','Letter is open',5)").run();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-local-images-'));
  t.mock.method(config, 'loadConfig', () => ({ storage: { local_path: root } }));
  t.after(() => {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('lmd-local-images-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  local.saveConfig(db, { default_size: '256x256' });
  return { db, root };
}
async function done(db, id) {
  for (let i = 0; i < 200; i++) {
    const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(id);
    if (['completed', 'failed', 'cancelled'].includes(row.status)) return row;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Mock image task did not finish');
}
async function server(t, options = {}) {
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#456789' } }).png().toBuffer();
  const calls = [], graphs = [], requests = [];
  const info = {};
  for (const key of provider.KEYS) for (const node of Object.values(provider.loadTemplate(key).workflow)) info[node.class_type] = { input: { required: {} } };
  info.LoadImage = { input: { required: {} } }; info.LoraLoaderModelOnly = { input: { required: {} } };
  info.ImageScaleToTotalPixels = { input: { required: {} } };
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); calls.push(req.url); requests.push({ endpoint: req.url, body });
    const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/object_info') return send(options.missingNodes ? {} : info);
    if (req.url === '/upload/image') return send({ name: 'uploaded.png', subfolder: 'input' });
    if (req.url === '/prompt') { graphs.push(JSON.parse(body).prompt); return send({ prompt_id: 'mock-' + graphs.length, node_errors: {} }); }
    if (req.url.startsWith('/history/')) return send(options.lost ? {} : { [req.url.slice('/history/'.length)]: { status: { completed: true, status_str: 'success', messages: [['execution_start', { timestamp: 1000 }], ['execution_success', { timestamp: 3000 }]] }, outputs: { '8': { images: [{ filename: 'result.png', type: 'output' }] } } } });
    if (req.url === '/queue') return send(options.queue || { queue_pending: [], queue_running: [] });
    if (req.url.startsWith('/view?')) return res.end(options.corrupt ? Buffer.from('not an image') : png);
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => srv.close(resolve)));
  return { base: 'http://127.0.0.1:' + srv.address().port, calls, requests, graphs, png };
}
test('image defaults respect explicit request and entity ownership without requiring a cloud key', t => {
  const { db } = fixture(t);
  models.select(db, { drama_id: 1, purpose: 'character', key: 'local:qwen-image-2.1' });
  assert.equal(models.resolve(db, { character_id: 1 }).key, 'local:qwen-image-2.1');
  assert.equal(models.resolve(db, { character_id: 1, image_model_key: 'local:qwen-image-2.1' }).key, 'local:qwen-image-2.1');
  assert.throws(() => models.resolve(db, { drama_id: 1, character_id: 2 }), /不属于/);
  assert.throws(() => models.resolve(db, { image_model_key: 'local:missing' }), /未配置/);
  assert.equal(models.resolve(db, { scene_id: 1 }).key, 'local:qwen-image-2.1');
});

test('all image purposes default locally and cloud requires an explicit request or saved choice', t => {
  const { db } = fixture(t);
  const cloud = require('../src/services/aiConfigService').createConfig(db, log, { service_type: 'image', name: 'Mock cloud', provider: 'openai', model: ['mock-cloud'], is_active: true, is_default: true, api_key: 'mock' });
  const key = `cloud:${cloud.id}:mock-cloud`;
  assert.ok(Object.values(models.defaults(db, 1)).every(value => value === 'local:qwen-image-2.1'));
  for (const body of [{}, { character_id: 1 }, { scene_id: 1 }, { storyboard_id: 1 }, { storyboard_id: 1, frame_type: 'last' }, { image_model_key: 'auto' }]) {
    assert.equal(models.resolve(db, body).key, 'local:qwen-image-2.1');
  }
  assert.equal(models.resolve(db, { drama_id: 1, image_model_key: key }).key, key);
  assert.equal(models.resolve(db, { drama_id: 1, model: 'mock-cloud' }).key, key);
  models.select(db, { drama_id: 1, purpose: 'scene', key });
  assert.equal(models.resolve(db, { scene_id: 1 }).key, key);
  assert.equal(models.resolve(db, { scene_id: 1, image_model_key: 'local:qwen-image-2.1' }).local, true);
  models.select(db, { drama_id: 1, purpose: 'scene', key: 'auto' });
  assert.equal(models.resolve(db, { scene_id: 1 }).local, true);
  assert.throws(() => models.resolve(db, { drama_id: 999 }), /项目不存在/);
});

test('frame pairs can reference an unselected first candidate and ignore removed optional scenes', async t => {
  const { db } = fixture(t), mock = await server(t);
  costs.saveSettings(db, { comfy_url: mock.base });
  db.prepare('UPDATE scenes SET deleted_at = ? WHERE id = 1').run(new Date().toISOString());
  const first = images.create(db, log, { storyboard_id: 1, frame_type: 'storyboard_first', prompt: '人物站在草地上，保持中文提示词。' });
  const firstRow = await done(db, first.id);
  assert.equal(firstRow.status, 'completed', firstRow.error_msg);
  const tail = images.create(db, log, { storyboard_id: 1, frame_type: 'storyboard_last', prompt: '人物向左转头。', reference_images: [firstRow.image_url] });
  const tailRow = await done(db, tail.id);
  assert.equal(tailRow.status, 'completed', tailRow.error_msg);
  assert.equal(tailRow.generation_mode, 'edit');
  const meta = JSON.parse(tailRow.generation_metadata);
  assert.match(meta.references[0].role, /first frame/);
  assert.equal(meta.references.length, 1);
  assert.equal(db.prepare('SELECT first_frame_image_id FROM storyboards WHERE id = 1').get().first_frame_image_id, null);
  assert.equal(mock.graphs.length, 2);
  db.prepare('UPDATE scenes SET drama_id = 2 WHERE id = 1').run();
  assert.throws(() => local.references(db, firstRow, {}), /场景参考不属于/);
});

test('deleting or re-extracting scenes clears their storyboard links without changing other scenes', t => {
  const { db } = fixture(t);
  const scenes = require('../src/services/sceneService');
  db.prepare('UPDATE scenes SET episode_id = 1 WHERE id = 1').run();
  db.prepare("INSERT INTO scenes(id,drama_id,location) VALUES(2,1,'Other room')").run();
  assert.equal(scenes.deleteScenesByEpisodeId(db, log, 1), 1);
  assert.equal(db.prepare('SELECT scene_id FROM storyboards WHERE id = 1').get().scene_id, null);
  assert.equal(db.prepare('SELECT deleted_at FROM scenes WHERE id = 2').get().deleted_at, null);
  db.prepare('UPDATE storyboards SET scene_id = 2 WHERE id = 1').run();
  assert.equal(scenes.deleteScene(db, log, 2).ok, true);
  assert.equal(db.prepare('SELECT scene_id FROM storyboards WHERE id = 1').get().scene_id, null);
});
test('Qwen rejects discarded references and unsafe sizes/seeds', t => {
  const { db } = fixture(t);

  assert.throws(() => local.prepare(db, { image_model_key: 'local:qwen-image-2.1', generation_mode: 't2i', reference_images: ['a.png'] }), /不能丢弃/);
  assert.throws(() => local.prepare(db, { image_model_key: 'local:qwen-image-2.1', seed: Number.MAX_SAFE_INTEGER + 1 }), /安全整数/);
  assert.throws(() => local.prepare(db, { image_model_key: 'local:qwen-image-2.1', local_size: '1000x1000' }), /倍数/);
  assert.throws(() => local.prepare(db, { character_id: 1, image_model_key: 'local:qwen-image-2.1', lora: { name: 'other.safetensors', character_id: 2, strength: 1 } }), /不属于/);
});
test('API templates are private-prompt free, wire references and keep optional identity LoRA disabled by default', () => {
  for (const key of provider.KEYS) {
    const bound = provider.bindWorkflow({ workflow_key: key, seed: 42, prompt: 'A room.', size: '256x256', references: key.endsWith('edit') ? ['first.png', 'identity.png'] : [] });
    assert.equal(bound.workflow['6'].inputs.seed, 42);
    if (key.endsWith('edit')) {
      assert.deepEqual(bound.workflow['6'].inputs.latent_image, ['5', 2]);
      assert.deepEqual(bound.workflow['5'].inputs['images.image_1'], ['4', 0]);
      assert.equal(bound.workflow['5'].inputs.resolution, 0);
    } else assert.equal(bound.workflow['4'].inputs.batch_size, 1);
    assert.equal(bound.workflow.identity_lora, undefined);
    if (key.endsWith('edit')) assert.deepEqual(bound.workflow['5'].inputs['images.image_2'], ['ref_resize_2', 0]);
  }
  const bound = provider.bindWorkflow({ workflow_key: 'qwen_image_21_t2i', seed: 1, size: '256x256', purpose: 'character', lora: { name: 'identity.safetensors', strength: 0.8 } });
  assert.deepEqual(bound.workflow['6'].inputs.model, ['identity_lora', 0]);
});

test('ComfyUI validation accepts V3 dynamic combo keys and rejects unavailable choices', async t => {
  t.mock.method(comfy, 'request', async () => ({ SaveVideo: { input: { required: { format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: {} }, { key: 'mp4', inputs: {} }] }] } } } }));
  assert.equal(await provider.validate('http://mock', { output: { class_type: 'SaveVideo', inputs: { format: 'auto' } } }), true);
  await assert.rejects(provider.validate('http://mock', { output: { class_type: 'SaveVideo', inputs: { format: 'missing' } } }), /不可用/);
});

test('only Qwen remains selectable locally and removed Flux requests are rejected', t => {
  const { db } = fixture(t);
  assert.deepEqual(models.catalog(db).filter(m => m.local).map(m => m.key), ['local:qwen-image-2.1']);
  assert.throws(() => models.resolve(db, { image_model_key: 'local:flux1-dev' }), /已移除/);
});

test('local asset negative prompts reach the persisted record and ComfyUI graph', async t => {
  const { db } = fixture(t), mock = await server(t); costs.saveSettings(db, { comfy_url: mock.base });
  db.prepare('UPDATE characters SET negative_prompt=? WHERE id=1').run('wrong clothing, watermark');
  models.select(db, { drama_id: 1, purpose: 'character', key: 'local:qwen-image-2.1' });
  const stored = client.createAndGenerateImage(db, log, { character_id: 1, prompt: 'A person.' });
  const explicit = client.createAndGenerateImage(db, log, { character_id: 1, prompt: 'A person.', user_negative_prompt: 'blurry' });
  assert.equal((await done(db, stored.id)).negative_prompt, 'wrong clothing, watermark');
  assert.equal((await done(db, explicit.id)).negative_prompt, 'blurry');
  assert.deepEqual(mock.graphs.map(g => g['5'].inputs.negative_prompt).sort(), ['blurry', 'wrong clothing, watermark']);
});

test('prop generation uses the local task, preserves main image and supports deliberate selection', async t => {
  const { db, root } = fixture(t), mock = await server(t); costs.saveSettings(db, { comfy_url: mock.base });
  db.prepare("UPDATE dramas SET style='comic illustration' WHERE id=1").run();
  t.mock.method(config, 'loadConfig', () => ({ storage: { local_path: root }, style: { default_prop_style: 'photorealistic, real skin texture' } }));
  const props = require('../src/services/propService');
  const prop = props.create(db, log, { drama_id: 1, name: 'Tea', prompt: 'A cup of milk tea.', image_url: 'old.png', negative_prompt: 'hands, people' });
  const other = props.create(db, log, { drama_id: 2, name: 'Other', prompt: 'Other.' });
  db.prepare('UPDATE props SET ref_image = ? WHERE id = ?').run('uploaded-reference.png', prop.id);
  assert.equal(local.references(db, { drama_id: 1, prop_id: prop.id }, {})[0].source, 'uploaded-reference.png');
  db.prepare('UPDATE props SET ref_image = NULL WHERE id = ?').run(prop.id);
  assert.equal(local.references(db, { drama_id: 1, prop_id: prop.id }, {})[0].source, 'old.png');
  models.select(db, { drama_id: 1, purpose: 'image', key: 'local:qwen-image-2.1' });
  assert.throws(() => models.resolve(db, { drama_id: 1, prop_id: other.id }), /不属于/);
  const taskId = require('../src/services/propImageGenerationService').generatePropImage(db, log, prop.id, { local_size: '256x256', seed: 24 });
  const created = db.prepare('SELECT * FROM image_generations WHERE task_id=?').get(taskId);
  assert.ok(created, 'prop must create a tracked image generation');
  const row = await done(db, created.id); assert.equal(row.status, 'completed', row.error_msg);
  assert.equal(row.prop_id, prop.id); assert.equal(row.seed, 24); assert.equal(row.negative_prompt, 'hands, people');
  assert.match(row.prompt, /comic illustration/); assert.doesNotMatch(row.prompt, /photorealistic|real skin texture/);
  assert.match(row.local_path, /\/props\//); assert.ok(fs.existsSync(path.join(root, row.local_path)));
  assert.equal(props.getById(db, prop.id).image_url, 'old.png');
  assert.equal(images.list(db, { prop_id: prop.id }).total, 1);
  local.adopt(db, row.id);
  assert.equal(props.getById(db, prop.id).image_url, row.image_url);
  assert.ok(JSON.parse(props.getById(db, prop.id).extra_images).includes('old.png'));
  const cfg = { storage: { local_path: root } };
  const zip = require('../src/services/dramaExportService').exportDrama(db, cfg, log, 1);
  const restored = require('../src/services/dramaImportService').importDrama(db, cfg, log, zip.buffer);
  const imported = db.prepare('SELECT * FROM image_generations WHERE drama_id=? AND prop_id IS NOT NULL').get(restored.drama_id);
  assert.ok(imported); assert.notEqual(imported.prop_id, prop.id);
});

test('invalid image parameters return HTTP 400 before creating a task', t => {
  const { db } = fixture(t);
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  require('../src/routes/images')(db, {}, log).create({ body: { image_model_key: 'local:qwen-image-2.1', seed: -1 } }, res);
  assert.equal(res.code, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n, 0);
});
test('project asset previews expose Qwen candidates without assigning main images', t => {
  const { db } = fixture(t);
  const insert = db.prepare("INSERT INTO image_generations(drama_id,character_id,engine,model_key,status,image_url,generation_metadata) VALUES(?,1,'comfyui',?,'completed',?,?)");
  const id = insert.run(1, 'local:qwen-image-2.1', '/static/candidate.png', '{}').lastInsertRowid;
  insert.run(1, 'local:qwen-image-2.1', '/static/selected.png', '{"result_usage":"selected"}');
  insert.run(2, 'local:qwen-image-2.1', '/static/foreign.png', '{}');
  insert.run(1, 'local:flux1-dev', '/static/old-flux.png', '{}');
  const character = require('../src/services/dramaService').getDrama(db, 1).characters[0];
  assert.equal(character.image_candidate.id, id);
  assert.equal(character.image_url, null); assert.equal(character.local_path, null);
});
test('both storyboard and asset task paths persist local results and require explicit candidate selection', async t => {
  const { db, root } = fixture(t), mock = await server(t);
  costs.saveSettings(db, { comfy_url: mock.base });
  const character = client.createAndGenerateImage(db, log, { drama_id: 1, character_id: 1, prompt: 'A person.', image_model_key: 'local:qwen-image-2.1', size: '1920x1920' });
  const first = images.create(db, log, { drama_id: 1, storyboard_id: 1, frame_type: 'storyboard_first', prompt: 'A person in a room.', image_model_key: 'local:qwen-image-2.1', seed: 42 });
  for (const record of [character, first]) {
    const row = await done(db, record.id); assert.equal(row.status, 'completed', row.error_msg);
    assert.equal(row.width, 256); assert.equal(row.generation_elapsed_seconds, 2); assert.ok(fs.existsSync(path.join(root, row.local_path)));
    assert.match(row.image_url, /^\/static\//); assert.ok(row.provider_task_id);
  }
  assert.equal(db.prepare('SELECT local_path FROM characters WHERE id=1').get().local_path, null);
  assert.equal(db.prepare('SELECT first_frame_image_id FROM storyboards WHERE id=1').get().first_frame_image_id, null);
  local.adopt(db, character.id); local.adopt(db, first.id);
  assert.equal(db.prepare('SELECT first_frame_image_id FROM storyboards WHERE id=1').get().first_frame_image_id, first.id);
  assert.ok(db.prepare('SELECT local_path FROM characters WHERE id=1').get().local_path);
  assert.ok(mock.graphs.every(g => g['6'].inputs.model[0] === '1'));
  const tail = images.create(db, log, { drama_id: 1, storyboard_id: 1, frame_type: 'storyboard_last', prompt: 'Letter opened.', image_model_key: 'local:qwen-image-2.1' });
  const tailRow = await done(db, tail.id); assert.equal(tailRow.status, 'completed', tailRow.error_msg);
  assert.equal(tailRow.generation_mode, 'edit');
  const metadata = JSON.parse(tailRow.generation_metadata);
  assert.match(metadata.references[0].role, /first frame/); assert.ok(metadata.references.some(r => r.role.includes('fixed identity')));
  local.adopt(db, tail.id);
  const shot = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.equal(shot.first_frame_image_id, first.id); assert.equal(shot.last_frame_image_id, tail.id);
  assert.equal(images.list(db, { drama_id: 1, engine: 'comfyui' }).total, 3);
});
test('missing first frame, missing node and corrupt output fail locally without binding or cloud fallback', async t => {
  const { db } = fixture(t), mock = await server(t, { missingNodes: true }); costs.saveSettings(db, { comfy_url: mock.base });
  const tail = images.create(db, log, { drama_id: 1, storyboard_id: 1, frame_type: 'last', prompt: 'End.', image_model_key: 'local:qwen-image-2.1' });
  assert.match((await done(db, tail.id)).error_msg, /先选定/);
  const image = images.create(db, log, { prompt: 'A room.', image_model_key: 'local:qwen-image-2.1' });
  assert.match((await done(db, image.id)).error_msg, /缺少图片节点/);
  assert.equal(mock.graphs.length, 0);
});
test('full image decoding detects corrupt and mismatched output before success', async t => {
  const { root } = fixture(t), mock = await server(t, { corrupt: true });
  const destination = path.join(root, 'bad.png');
  await assert.rejects(provider.download(mock.base, { filename: 'result.png' }, destination, { width: 256, height: 256 }));
  assert.equal(fs.existsSync(destination), false); assert.equal(fs.existsSync(destination + '.part'), false);
  const valid = await server(t);
  await assert.rejects(provider.download(valid.base, { filename: 'result.png' }, destination, { width: 512, height: 512 }), /尺寸/);
  assert.equal(fs.existsSync(destination), false); assert.equal(fs.existsSync(destination + '.part'), false);
});
test('safe cancellation removes only owned queued ID and blocks global interrupt when other jobs run', async t => {
  const { db } = fixture(t);
  const options = { queue: { queue_pending: [[0, 'other'], [1, 'owned']], queue_running: [] } };
  const mock = await server(t, options); costs.saveSettings(db, { comfy_url: mock.base });
  const task = require('../src/services/taskService').createTask(db, log, 'image_generation', '1');
  const insert = db.prepare("INSERT INTO image_generations(drama_id,engine,model_key,workflow_key,provider_task_id,task_id,status,generation_metadata) VALUES(1,'comfyui','local:qwen-image-2.1','qwen_image_21_t2i','owned',?,'processing','{}')").run(task.id);
  await local.cancel(db, insert.lastInsertRowid);
  assert.deepEqual(JSON.parse(mock.requests.at(-1).body), { delete: ['owned'] });
  assert.equal(db.prepare('SELECT status FROM image_generations WHERE id=?').get(insert.lastInsertRowid).status, 'cancelled');
  options.queue = { queue_pending: [], queue_running: [[0, 'owned'], [1, 'other']] };
  await assert.rejects(comfy.cancel(mock.base, 'owned'), /不能安全取消/);
});
test('recover saved prompt ID without resubmission and preserve completed records on later errors', async t => {
  const { db } = fixture(t), mock = await server(t); costs.saveSettings(db, { comfy_url: mock.base });
  const task = require('../src/services/taskService').createTask(db, log, 'image_generation', '1');
  const id = db.prepare("INSERT INTO image_generations(drama_id,engine,model_key,model,workflow_key,provider_task_id,size,seed,task_id,status,generation_metadata) VALUES(1,'comfyui','local:qwen-image-2.1','qwen-image-2.1','qwen_image_21_t2i','saved','256x256',42,?,'processing','{}')").run(task.id).lastInsertRowid;
  assert.deepEqual(local.recover(db, log), [task.id]);
  assert.equal((await done(db, id)).status, 'completed'); assert.equal(mock.graphs.length, 0);
  await local.run(db, log, id, true); assert.equal(db.prepare('SELECT status FROM image_generations WHERE id=?').get(id).status, 'completed');
});
test('vanished ComfyUI prompt is reported without retrying submission', async t => {
  const mock = await server(t, { lost: true });
  await assert.rejects(provider.waitForOutput(mock.base, 'gone', provider.loadTemplate('qwen_image_21_t2i').mapping, { poll_interval_ms: 1 }), /任务已消失/);
  assert.equal(mock.graphs.length, 0);
});
test('project archive preserves local storyboard and asset history metadata and remaps bindings', async t => {
  const { db, root } = fixture(t), mock = await server(t); costs.saveSettings(db, { comfy_url: mock.base });
  const character = client.createAndGenerateImage(db, log, { character_id: 1, drama_id: 1, prompt: 'Person.', image_model_key: 'local:qwen-image-2.1', seed: 42 });
  const first = images.create(db, log, { drama_id: 1, storyboard_id: 1, frame_type: 'first', prompt: 'Room.', image_model_key: 'local:qwen-image-2.1', seed: 43 });
  await done(db, character.id); await done(db, first.id); local.adopt(db, first.id);
  const exported = require('../src/services/dramaExportService').exportDrama(db, { storage: { local_path: root } }, log, 1);
  const importer = require('../src/services/dramaImportService');
  const imported = importer.importDrama(db, { storage: { local_path: root } }, log, exported.buffer);
  const rows = db.prepare('SELECT * FROM image_generations WHERE drama_id=?').all(imported.drama_id);
  assert.equal(rows.length, 2); assert.ok(rows.every(r => r.engine === 'comfyui' && r.provider_task_id === null));
  assert.deepEqual(rows.map(r => r.seed).sort(), [42, 43]);
  const shot = db.prepare('SELECT * FROM storyboards WHERE episode_id IN (SELECT id FROM episodes WHERE drama_id=?)').get(imported.drama_id);
  assert.ok(shot.first_frame_image_id);
});
test('H3 FL2VA binds both uploaded keyframes without changing samplers or dropping the ending frame', () => {
  const h3 = require('../src/services/comfyVideoProvider');
  const original = h3.loadTemplate().workflow;
  const bound = h3.bindWorkflow({ image: 'first.png', last_frame: 'last.png', prompt: 'Reach the end frame.', duration: 5, seed: 42 });
  assert.equal(bound.mapping.mode, 'FL2VA');
  assert.equal(bound.workflow.last_frame_upload.inputs.image, 'last.png');
  assert.deepEqual(bound.workflow['105_104'].inputs.last_frame, ['last_frame_resized', 0]);
  assert.deepEqual(bound.workflow['105_9'], original['105_9']);
});
test('tail link extracts the actual last decoded frame and preserves the next shot ending frame', async t => {
  const { db, root } = fixture(t);
  db.prepare('INSERT INTO storyboards(id,episode_id,storyboard_number,last_frame_image_id) VALUES(2,1,2,999)').run();
  const { spawnSync } = require('child_process');
  const ffmpeg = require('../src/utils/ffmpegPath').getFfmpegPath();
  const frame = color => { const out = Buffer.alloc(64 * 64 * 3); for (let i = 0; i < out.length; i += 3) { out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2]; } return out; };
  const video = path.join(root, 'colors.mp4');
  const encode = spawnSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '64x64', '-framerate', '2', '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video], {
    input: Buffer.concat([frame([255, 0, 0]), frame([0, 255, 0]), frame([0, 0, 255])]), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(encode.status, 0, encode.stderr || encode.error?.message);
  db.prepare("INSERT INTO video_generations(drama_id,storyboard_id,status,local_path,video_url) VALUES(1,1,'completed','colors.mp4','/static/colors.mp4')").run();
  let reply, status = 200;
  const res = { status(code) { status = code; return this; }, json(value) { reply = value; return this; } };
  await require('../src/services/tailFrameLinkService')(db, { storage: { local_path: root } }, log).linkTailFrame({ params: { id: '1' }, body: { drama_id: 1 } }, res);
  assert.equal(status, 200, JSON.stringify(reply)); assert.equal(reply.success, true);
  const rgb = await sharp(path.join(root, reply.local_path)).raw().toBuffer();
  assert.ok(rgb[2] > 220 && rgb[0] < 30 && rgb[1] < 30, 'final frame must be blue, rather than the green frame one second before the end');
  const next = db.prepare('SELECT * FROM storyboards WHERE id=2').get();
  assert.equal(next.last_frame_image_id, 999); assert.equal(next.first_frame_image_id, reply.new_first_frame_image_id);
});
test('local storyboard grids reuse business prompts, split panels and require deliberate keyframe selection', async t => {
  const { db } = fixture(t), mock = await server(t); costs.saveSettings(db, { comfy_url: mock.base });
  t.mock.method(images, 'buildQuadGridPrompt', async () => 'Create a 2x2 grid with EXACTLY four panels.');
  const record = images.create(db, log, { drama_id: 1, storyboard_id: 1, frame_type: 'quad_grid', prompt: 'Letter.', image_model_key: 'local:qwen-image-2.1' });
  const row = await done(db, record.id); assert.equal(row.status, 'completed', row.error_msg);
  assert.match(mock.graphs[0]['5'].inputs.prompt, /2x2 grid/); assert.doesNotMatch(mock.graphs[0]['5'].inputs.prompt, /one continuous image/);
  const panels = db.prepare("SELECT * FROM image_generations WHERE generation_mode='crop'").all(); assert.equal(panels.length, 4);
  assert.ok(panels.every(p => p.width === 128 && p.model_key === 'local:qwen-image-2.1'));
  assert.equal(db.prepare('SELECT first_frame_image_id FROM storyboards WHERE id=1').get().first_frame_image_id, null);
  local.adopt(db, panels[0].id, { frame_type: 'first' }); local.adopt(db, panels[3].id, { frame_type: 'last' });
  const shot = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.equal(shot.first_frame_image_id, panels[0].id); assert.equal(shot.last_frame_image_id, panels[3].id);
});
