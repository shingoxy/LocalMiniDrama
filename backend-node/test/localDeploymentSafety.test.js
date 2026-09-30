const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { registerSecret, redactSecrets } = require('../src/utils/redactSecrets');
const aiConfigService = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const quiet = { info() {}, warn() {}, error() {}, errorw() {} };

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('registered credentials are removed from URL, JSON and plain error strings', () => {
  registerSecret('synthetic-test-secret/123');
  const output = redactSecrets('synthetic-test-secret/123 ' + encodeURIComponent('synthetic-test-secret/123') + ' ?key=unknown-secret {"api_key":"another-secret"} Bearer bearer-secret');
  for (const secret of ['synthetic-test-secret', 'unknown-secret', 'another-secret', 'bearer-secret']) assert.ok(!output.includes(secret));
});

test('Gemini image authentication uses a header and never the request URL', async () => {
  await withServer(async (req, res) => {
    assert.equal(req.headers['x-goog-api-key'], 'synthetic-image-secret');
    assert.ok(!req.url.includes('key='));
    assert.match(req.url, /:generateContent$/);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'c3ludGhldGlj' } }] } }] }));
  }, async (base) => {
    const db = new Database(':memory:');
    try {
      require('../src/db/migrate').runMigrationsAndEnsure(db);
      aiConfigService.createConfig(db, quiet, { name: 'test', service_type: 'image', provider: 'gemini', api_protocol: 'gemini', base_url: base, model: ['gemini-2.5-flash-image'], api_key: 'synthetic-image-secret' });
      const result = await imageClient.callImageApi(db, quiet, { prompt: 'test', model: 'gemini-2.5-flash-image', size: '1024x1024', image_gen_id: 0 });
      assert.ok(!result.error, result.error);
    } finally { db.close(); }
  });
});

test('Veo connection test queries metadata instead of submitting generation', async () => {
  await withServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1beta/models/veo-3.1-generate-preview');
    assert.equal(req.headers['x-goog-api-key'], 'synthetic-veo-secret');
    res.end('{"name":"models/veo-3.1-generate-preview"}');
  }, (base) => aiConfigService.testConnection({ provider: 'gemini', service_type: 'video', base_url: base, model: 'veo-3.1-generate-preview', api_key: 'synthetic-veo-secret' }));
});

test('Gemini text uses the official OpenAI-compatible streaming route', async () => {
  await withServer(async (req, res) => {
    assert.equal(req.url, '/v1beta/openai/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer synthetic-text-secret');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert.equal(JSON.parse(raw).stream, true);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"local text result"}}]}\n\ndata: [DONE]\n\n');
  }, async (base) => {
    const db = new Database(':memory:');
    try {
      require('../src/db/migrate').runMigrationsAndEnsure(db);
      const config = aiConfigService.createConfig(db, quiet, { name: 'test', service_type: 'text', provider: 'gemini', api_protocol: 'openai', base_url: base + '/v1beta/openai', model: ['gemini-2.5-pro'], api_key: 'synthetic-text-secret' });
      assert.equal(config.endpoint, '/chat/completions');
      const result = await require('../src/services/aiClient').generateText(db, quiet, 'text', 'test', '', {});
      assert.equal(result, 'local text result');
    } finally { db.close(); }
  });
});

test('Veo download sends its key to Google and removes it on a CDN redirect', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-auth-test-'));
  const db = new Database(':memory:');
  const configModule = require('../src/config');
  const videoClient = require('../src/services/videoClient');
  const oldConfig = configModule.loadConfig;
  const oldCall = videoClient.callVideoApi;
  const oldFetch = global.fetch;
  let downloads = 0;
  try {
    require('../src/db/migrate').runMigrationsAndEnsure(db);
    aiConfigService.createConfig(db, quiet, { name: 'test', service_type: 'video', provider: 'gemini', api_protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com', model: ['veo-3.1-generate-preview'], api_key: 'synthetic-download-secret' });
    db.prepare('INSERT INTO video_generations (drama_id, provider, model, prompt, status, created_at) VALUES (1, ?, ?, ?, ?, ?)').run('gemini', 'veo-3.1-generate-preview', 'test', 'pending', new Date().toISOString());
    configModule.loadConfig = () => ({ storage: { local_path: storage, base_url: 'http://localhost:5679/static' } });
    videoClient.callVideoApi = async () => ({ video_url: 'https://generativelanguage.googleapis.com/video-test.mp4' });
    global.fetch = async (url, options) => {
      downloads++;
      if (new URL(url).hostname === 'generativelanguage.googleapis.com') {
        assert.equal(options.headers['x-goog-api-key'], 'synthetic-download-secret');
        return new Response('', { status: 302, headers: { location: 'https://cdn.invalid/video-test.mp4' } });
      }
      assert.deepEqual(options.headers, {});
      return new Response('synthetic video transport fixture', { status: 200 });
    };
    await require('../src/services/videoService').processVideoGeneration(db, quiet, 1);
    assert.equal(downloads, 2);
    const result = db.prepare('SELECT status, local_path FROM video_generations WHERE id=1').get();
    assert.equal(result.status, 'completed');
    assert.ok(result.local_path);
  } finally {
    configModule.loadConfig = oldConfig; videoClient.callVideoApi = oldCall; global.fetch = oldFetch;
    db.close();
    assert.ok(path.resolve(storage).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(storage).startsWith('lmd-auth-test-'));
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('disabled image proxy makes no network request', async () => {
  const config = require('../src/config');
  const previous = config.loadConfig;
  const oldFetch = global.fetch;
  config.loadConfig = () => ({ image_proxy: { enabled: false } });
  global.fetch = () => { throw new Error('Unexpected upload'); };
  try {
    const result = await require('../src/services/uploadService').uploadToImageProxy(Buffer.from('synthetic'), 'image/png', quiet, 'test');
    assert.equal(result, null);
  } finally { config.loadConfig = previous; global.fetch = oldFetch; }
});

test('Veo submits the requested preview model and parses an operation result', async () => {
  let submitted = false;
  await withServer(async (req, res) => {
    assert.equal(req.headers['x-goog-api-key'], 'synthetic-video-secret');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      assert.equal(req.url, '/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.parameters.durationSeconds, 8);
      assert.equal(body.instances[0].image.mimeType, 'image/png');
      submitted = true;
      res.end('{"name":"operations/local-test"}');
    } else {
      assert.equal(req.url, '/v1beta/operations/local-test');
      res.end('{"done":true,"response":{"generateVideoResponse":{"generatedSamples":[{"video":{"uri":"https://generativelanguage.googleapis.com/local-test.mp4"}}]}}}');
    }
  }, async (base) => {
    const db = new Database(':memory:');
    try {
      require('../src/db/migrate').runMigrationsAndEnsure(db);
      const config = aiConfigService.createConfig(db, quiet, { name: 'test', service_type: 'video', provider: 'gemini', api_protocol: 'gemini', base_url: base, model: ['veo-3.1-generate-preview'], api_key: 'synthetic-video-secret' });
      const client = require('../src/services/videoClient');
      const result = await client.callVideoApi(db, quiet, { prompt: 'test', model: 'veo-3.1-generate-preview', duration: 8, aspect_ratio: '16:9', image_url: 'data:image/png;base64,c3ludGhldGlj', video_gen_id: 0 });
      assert.equal(result.task_id, 'operations/local-test');
      const polled = await client.pollVideoTask(db, quiet, 0, result.task_id, config, 1, 1);
      assert.match(polled.video_url, /local-test.mp4$/);
      assert.ok(submitted);
    } finally { db.close(); }
  });
});

test('AI config list omits credentials while server keeps its saved key', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE ai_service_configs (id INTEGER PRIMARY KEY, service_type TEXT, api_key TEXT, deleted_at TEXT, is_default INTEGER, priority INTEGER, created_at TEXT)');
    db.prepare('INSERT INTO ai_service_configs VALUES (1, ?, ?, NULL, 0, 0, ?)').run('text', 'synthetic-list-secret', new Date().toISOString());
    let payload;
    const res = { status() { return this; }, json(value) { payload = value; } };
    require('../src/routes/aiConfig')(db, quiet, {}).list({ query: {} }, res);
    assert.equal(payload.data[0].api_key, '');
    assert.equal(payload.data[0].has_api_key, true);
    assert.equal(aiConfigService.getConfig(db, 1).api_key, 'synthetic-list-secret');
  } finally { db.close(); }
});
