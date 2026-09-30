const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const aiConfigService = require('../src/services/aiConfigService');
const sources = require('../src/services/arkImageSource');

const IMAGE = 'doubao-seedream-5-0-pro-260628';
const VIDEO = 'doubao-seedance-2-5-260628';
const ORIGINAL = 'https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/original.png?signature=keep-exactly';
const LOCAL = 'http://127.0.0.1:3013/static/images/original.png';
const DAY = 86400000;

function fixture(t) {
  const db = new Database(':memory:');
  require('../src/db/migrate').runMigrationsAndEnsure(db);
  t.after(() => db.close());
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-image-source-'));
  fs.mkdirSync(path.join(storage, 'images'));
  fs.writeFileSync(path.join(storage, 'images/original.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1kAAAAASUVORK5CYII=', 'base64'));
  t.after(() => {
    assert.ok(path.resolve(storage).startsWith(path.join(os.tmpdir(), 'ark-image-source-')));
    fs.rmSync(storage, { recursive: true, force: true });
  });
  const logs = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug', 'errorw', 'infow'].map((level) => [level, (message, details) => logs.push({ message, ...details })]));
  const requests = [];
  const config = (model, extra = {}) => ({
    provider: 'volcengine', base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: 'synthetic-same-account-key', model: [model], is_default: true,
    api_protocol: model === IMAGE ? 'volcengine' : 'volcengine_omni', ...extra,
  });
  const createConfig = (service_type, model, extra) => aiConfigService.createConfig(db, log, { name: 'mock', service_type, ...config(model, extra) });
  createConfig('image', IMAGE);
  createConfig('storyboard_image', IMAGE);
  createConfig('video', VIDEO);
  t.mock.method(require('../src/config'), 'loadConfig', () => ({
    app: { name: 'mock' }, style: {}, storage: { local_path: storage, base_url: 'http://127.0.0.1:3013' },
    image_proxy: { use_for_video: true, upload_url: 'https://mock.invalid/proxy' },
  }));
  t.mock.method(require('../src/services/aiClient'), 'postJSONWithTimeout', async (url, headers, body) => {
    assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
    requests.push({ kind: 'image', body });
    return { statusCode: 200, raw: JSON.stringify({ model: body.model, created: Math.floor(Date.now() / 1000), data: [{ url: ORIGINAL }] }) };
  });
  // imageClient captures postJSONWithTimeout at module load.
  delete require.cache[require.resolve('../src/services/imageClient')];
  const imageClient = require('../src/services/imageClient');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://mock.invalid/proxy') {
      requests.push({ kind: 'proxy' });
      return new Response(JSON.stringify({ url: 'https://mock.invalid/copied.png' }), { status: 200 });
    }
    assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    requests.push({ kind: 'video', body: JSON.parse(options.body) });
    return new Response('{"id":"mock-task","status":"queued"}', { status: 200 });
  });
  const opts = { drama_id: 1, prompt: 'A synthetic cinematic scene', model: VIDEO, duration: 5, reference_urls: [LOCAL], files_base_url: 'http://127.0.0.1:3013', storage_local_path: storage, video_gen_id: 123 };
  const insertImage = (extra = {}) => {
    const row = { image_url: '/static/images/original.png', local_path: 'images/original.png', ...sources.imageResponseMetadata(config(IMAGE), IMAGE, {}, ORIGINAL, 0), ...extra };
    const id = db.prepare(`INSERT INTO image_generations (drama_id, status, provider, model, image_url, local_path,
      original_url, generated_at, generation_mode, ark_key_fingerprint) VALUES (1, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.provider, row.model, row.image_url, row.local_path, row.original_url, row.generated_at, row.generation_mode, row.ark_key_fingerprint).lastInsertRowid;
    return Number(id);
  };
  return { db, storage, log, logs, requests, config, createConfig, imageClient, opts, insertImage };
}

test('Seedream API metadata records the actual provider/model, original URL, timestamp and generation mode', async (t) => {
  const f = fixture(t);
  for (const model of [IMAGE, 'doubao-seedream-5-0-lite-260128']) {
    f.createConfig('image', model, { api_protocol: 'volcengine' });
    for (const count of [0, 2]) {
      const result = await f.imageClient.callImageApi(f.db, f.log, { prompt: 'A synthetic portrait', model, reference_image_urls: count ? ['https://mock.invalid/a.png', 'https://mock.invalid/b.png'] : undefined });
      assert.equal(result.original_url, ORIGINAL);
      assert.equal(result.model, model);
      assert.equal(result.provider, 'volcengine');
      assert.ok(Date.parse(result.generated_at));
      assert.equal(result.generation_mode, count ? 'image_to_image' : 'text_to_image');
      assert.match(result.ark_key_fingerprint, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(result).includes('synthetic-same-account-key'), false);
    }
  }
});

test('Seedream original survives storyboard local saving and reaches Seedance 2.5 unchanged with proxy enabled', async (t) => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO dramas (id, title) VALUES (1, 'Mock')").run();
  f.db.prepare("INSERT INTO episodes (id, drama_id, episode_number) VALUES (1, 1, 1)").run();
  f.db.prepare("INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (1, 1, 1, 'Mock scene')").run();
  const id = f.db.prepare("INSERT INTO image_generations (drama_id, storyboard_id, provider, prompt, status) VALUES (1, 1, 'openai', 'A synthetic person by a lighthouse', 'pending')").run().lastInsertRowid;
  t.mock.method(require('../src/services/uploadService'), 'downloadImageToLocal', async () => 'images/original.png');
  t.mock.method(require('../src/services/aiClient'), 'generateText', async () => 'A synthetic person by a lighthouse');
  delete require.cache[require.resolve('../src/services/imageService')];
  const imageService = require('../src/services/imageService');
  await imageService.processImageGeneration(f.db, f.log, Number(id));
  const row = f.db.prepare('SELECT * FROM image_generations WHERE id = ?').get(id);
  assert.equal(row.status, 'completed', row.error_msg);
  assert.equal(row.image_url, '/static/images/original.png');
  assert.equal(row.original_url, ORIGINAL);
  assert.equal(row.model, IMAGE);
  assert.equal(row.provider, 'volcengine');
  assert.equal(imageService.getById(f.db, id).original_url, ORIGINAL);
  await require('../src/services/videoClient').callVideoApi(f.db, f.log, f.opts);
  assert.equal(f.requests.filter((r) => r.kind === 'proxy').length, 0);
  assert.equal(f.requests.at(-1).body.content[1].image_url.url, ORIGINAL);
  const trace = f.logs.find((r) => r.content_field === 'content[1]');
  assert.equal(trace.image_gen_id, Number(id));
  assert.equal(trace.storyboard_id, 1);
  assert.equal(trace.source_kind, 'ark_trusted_original');
  assert.equal(trace.local_path, 'images/original.png');
  assert.equal(JSON.stringify(trace).includes('signature='), false);
});

test('role/scene image generation also persists original metadata', async (t) => {
  const f = fixture(t);
  t.mock.method(require('../src/services/uploadService'), 'downloadImageToLocal', async () => 'images/original.png');
  const item = f.imageClient.createAndGenerateImage(f.db, f.log, { drama_id: 1, prompt: 'A synthetic portrait' });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const row = f.db.prepare('SELECT * FROM image_generations WHERE id = ?').get(item.id);
    if (row.status === 'completed' || row.status === 'failed') {
      assert.equal(row.status, 'completed', row.error_msg);
      assert.equal(row.original_url, ORIGINAL);
      assert.equal(row.provider, 'volcengine');
      assert.equal(row.model, IMAGE);
      return;
    }
  }
  assert.fail('mock image generation did not finish');
});

test('trusted first/last frames work for Seedance 2.5 and 2.0 in both Ark protocols', async (t) => {
  const f = fixture(t);
  f.insertImage();
  for (const model of [VIDEO, 'doubao-seedance-2-0-260128']) {
    for (const protocol of ['volcengine_omni', 'volcengine']) {
      f.createConfig('video', model, { api_protocol: protocol });
      await require('../src/services/videoClient').callVideoApi(f.db, f.log, {
        ...f.opts, model, reference_urls: undefined, first_frame_local_path: 'images/original.png',
        last_frame_url: 'asset://authorized-tail',
      });
      assert.equal(f.requests.at(-1).body.content[1].image_url.url, ORIGINAL);
      assert.equal(f.requests.at(-1).body.content[1].role, 'first_frame');
      assert.equal(f.requests.at(-1).body.content[2].image_url.url, 'asset://authorized-tail');
    }
  }
  assert.equal(f.requests.some((r) => r.kind === 'proxy'), false);
});

test('ordinary local and Seedream image-to-image materials keep the existing proxy route and material traces', async (t) => {
  const f = fixture(t);
  const id = f.insertImage({ generation_mode: 'image_to_image' });
  await require('../src/services/videoClient').callVideoApi(f.db, f.log, f.opts);
  assert.equal(f.requests[0].kind, 'proxy');
  assert.equal(f.requests.at(-1).body.content[1].image_url.url, 'https://mock.invalid/copied.png');
  const trace = f.logs.find((r) => r.content_field === 'content[1]');
  assert.equal(trace.image_gen_id, id);
  assert.equal(trace.source_kind, 'not_text_to_image');
  assert.equal(trace.source_input, LOCAL);
});

test('expired original URL fails clearly without sending the image to a proxy or paid video endpoint', async (t) => {
  const f = fixture(t);
  f.insertImage({ generated_at: new Date(Date.now() - DAY - 1000).toISOString() });
  await assert.rejects(require('../src/services/videoClient').callVideoApi(f.db, f.log, f.opts), /24 小时.*30 天/);
  assert.equal(f.requests.length, 0);
});

test('missing metadata, unverifiable sources, image edits, old models and expired trust are never marked trusted', (t) => {
  const f = fixture(t);
  const cases = [
    { generated_at: null }, { generated_at: new Date(Date.now() + DAY).toISOString() },
    { generated_at: new Date(Date.now() - 30 * DAY).toISOString() },
    { original_url: null }, { ark_key_fingerprint: null }, { ark_key_fingerprint: 'different-account' },
    { generation_mode: 'image_to_image' }, { model: 'doubao-seedream-4-5-251128' },
  ];
  for (const extra of cases) {
    f.db.prepare('DELETE FROM image_generations').run();
    f.insertImage(extra);
    const result = sources.applyTrustedArkImages(f.db, f.config(VIDEO), f.opts);
    assert.equal(result.reference_urls[0], LOCAL);
    assert.notEqual(result.seedance_image_sources[0].source_kind, 'ark_trusted_original');
  }
  f.db.prepare('DELETE FROM image_generations').run();
  f.insertImage();
  assert.equal(sources.applyTrustedArkImages(f.db, f.config(VIDEO, { base_url: 'https://third-party.invalid' }), f.opts).reference_urls[0], LOCAL);
  assert.equal(sources.applyTrustedArkImages(f.db, f.config(VIDEO), { ...f.opts, reference_urls: ['https://third-party.invalid/static/images/original.png'] }).reference_urls[0], 'https://third-party.invalid/static/images/original.png');
});

test('different Ark keys still preserve the official original and defer account ownership to Ark', async (t) => {
  const f = fixture(t);
  const otherKeySource = sources.imageResponseMetadata(f.config(IMAGE, { api_key: 'synthetic-other-key' }), IMAGE, {}, ORIGINAL, 0);
  f.insertImage(otherKeySource);
  await require('../src/services/videoClient').callVideoApi(f.db, f.log, f.opts);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.content[1].image_url.url, ORIGINAL);
  const trace = f.logs.find((r) => r.content_field === 'content[1]');
  assert.equal(trace.source_kind, 'ark_original_account_unverified');
});

test('authorized asset URI bypasses proxy, while ordinary third-party URLs remain unchanged', async (t) => {
  const f = fixture(t);
  await require('../src/services/videoClient').callVideoApi(f.db, f.log, { ...f.opts, reference_urls: ['asset://authorized-portrait', 'https://third-party.invalid/image.png'] });
  assert.deepEqual(f.requests.at(-1).body.content.slice(1).map((p) => p.image_url.url), ['asset://authorized-portrait', 'https://third-party.invalid/image.png']);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.logs.filter((r) => r.content_field).map((r) => r.content_field), ['content[1]', 'content[2]']);
});

test('Ark moderation errors still surface unchanged without proxy fallback or retries', async (t) => {
  const f = fixture(t);
  f.insertImage();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).content[1].image_url.url, ORIGINAL);
    return new Response(JSON.stringify({ error: { code: 'InputImageSensitiveContentDetected.PrivacyInformation', message: "The input image 'content[1]' may contain real person." } }), { status: 400 });
  });
  const result = await require('../src/services/videoClient').callVideoApi(f.db, f.log, f.opts);
  assert.match(result.error, /400.*content\[1\].*real person/);
  assert.equal(calls, 1);
});
