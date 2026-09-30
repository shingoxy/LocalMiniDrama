const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const aiConfigService = require('../src/services/aiConfigService');
const imageClient = require('../src/services/imageClient');
const videoClient = require('../src/services/videoClient');
const preset = require('../src/services/westernShortDramaPreset');
const quiet = { info() {}, warn() {}, error() {}, errorw() {}, infow() {}, debug() {} };
const IMAGE = 'doubao-seedream-5-0-pro-260628';
const VIDEO = 'doubao-seedance-2-5-260628';
const OLD_VIDEO = 'doubao-seedance-2-0-260128';

function makeDb(t) {
  const db = new Database(':memory:');
  require('../src/db/migrate').runMigrationsAndEnsure(db);
  t.after(() => db.close());
  return db;
}

async function withArk(t, run) {
  const requests = [];
  let pollStatuses = ['queued', 'running', 'succeeded'];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/chat/completions')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: {"choices":[{"delta":{"content":"mock English script"}}]}\n\ndata: [DONE]\n\n');
    } else if (req.method === 'GET') {
      const status = pollStatuses.shift() || 'succeeded';
      res.end(JSON.stringify({ id: 'mock-task', status, ...(status === 'succeeded' ? { content: { video_url: 'https://mock.invalid/video.mp4' }, duration: 30 } : {}), ...(status === 'failed' ? { error: { message: 'mock task failed' } } : {}) }));
    } else if (req.url.endsWith('/images/generations')) res.end('{"data":[{"url":"https://mock.invalid/image.png"}]}');
    else res.end('{"id":"mock-task","status":"queued"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const db = makeDb(t);
  const base = `http://127.0.0.1:${server.address().port}/api/v3`;
  const create = (service_type, model, extra = {}) => aiConfigService.createConfig(db, quiet, {
    name: 'mock', service_type, model: [model], provider: service_type === 'video' ? 'volces' : 'volcengine',
    api_protocol: service_type === 'video' ? 'volcengine_omni' : 'volcengine',
    base_url: base, api_key: 'synthetic-ark-key', is_default: true, ...extra,
  });
  try { await run({ db, requests, create, setStatuses: (statuses) => { pollStatuses = statuses; } }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('Seedream 5.0 Pro sends text, single and multiple references in portrait for both image services', async (t) => {
  await withArk(t, async ({ db, requests, create }) => {
    for (const serviceType of ['image', 'storyboard_image']) {
      create(serviceType, IMAGE);
      for (const count of [0, 1, 10]) {
        await imageClient.callImageApi(db, quiet, {
          prompt: 'A portrait', model: IMAGE, imageServiceType: serviceType, size: '1080x1920', quality: 'high',
          reference_image_urls: Array.from({ length: count }, (_, i) => `https://mock.invalid/ref${i}.png`),
        });
        const req = requests.at(-1);
        assert.equal(req.url, '/api/v3/images/generations');
        assert.equal(req.auth, 'Bearer synthetic-ark-key');
        assert.equal(req.body.model, IMAGE);
        assert.equal(req.body.size, '1080x1920');
        assert.equal(req.body.image?.length || 0, count);
        assert.equal(req.body.watermark, false);
        for (const key of ['n', 'quality', 'negative_prompt', 'sequential_image_generation']) assert.equal(key in req.body, false);
      }
    }
    const before = requests.length;
    await assert.rejects(imageClient.callImageApi(db, quiet, { prompt: 'test', model: IMAGE, reference_image_urls: Array(11).fill('https://mock.invalid/ref.png') }), /10/);
    assert.equal(requests.length, before);
  });
});

test('Seedream 5.0 Pro uses its own pixel bounds and preserves 9:16; 4.5 keeps the existing minimum', () => {
  for (const value of ['512x512', '360x640', '2160x3840', '720x1280', '1440x2560']) {
    const [w, h] = imageClient.fixSeedreamSize(value, true).split('x').map(Number);
    assert.ok(w * h >= 921600 && w * h <= 4624220);
    if (!value.includes('512')) assert.equal(w / h, 9 / 16);
  }
  assert.equal(imageClient.fixSeedreamSize(undefined, true), '2K');
  assert.equal(imageClient.fixSeedreamSize('1.5K', true), '1.5K');
  assert.throws(() => imageClient.fixSeedreamSize('4K', true), /尺寸/);
  assert.throws(() => imageClient.fixSeedreamSize('10x1000', true), /宽高比/);
  const [w, h] = imageClient.fixSeedreamSize('1080x1920').split('x').map(Number);
  assert.ok(w * h >= 3686400);
});

test('DeepSeek reuses the OpenAI-compatible streaming client and accepts an editable model name', async (t) => {
  await withArk(t, async ({ db, requests, create }) => {
    create('text', 'custom-deepseek-model', { provider: 'deepseek', api_protocol: 'openai', endpoint: '/chat/completions' });
    const result = await require('../src/services/aiClient').generateText(db, quiet, 'text', 'A supplied premise', 'Use American English', { model: 'custom-deepseek-model' });
    assert.equal(result, 'mock English script');
    const req = requests[0];
    assert.equal(req.url, '/api/v3/chat/completions');
    assert.equal(req.body.model, 'custom-deepseek-model');
    assert.equal(req.body.stream, true);
    assert.equal(req.auth, 'Bearer synthetic-ark-key');
  });
});

test('Seedance versions dynamically use 30 or 15 second bounds, including custom Ark endpoint profiles', () => {
  for (const [input, expected] of [[4, 4], [20, 20], [30, 30], [60, 30], [2, 4], [-1, -1], [undefined, -1]]) assert.equal(videoClient.normalizeVolcengineDuration(VIDEO, input), expected);
  assert.equal(videoClient.normalizeVolcengineDuration(OLD_VIDEO, 30), 15);
  assert.equal(videoClient.normalizeVolcengineDuration(OLD_VIDEO, -1), -1);
  assert.equal(videoClient.normalizeVolcengineDuration('ep-custom', 25, { settings: '{"seedance_version":"2.5"}' }), 25);
  assert.equal(videoClient.normalizeVolcengineDuration(OLD_VIDEO, 30, { settings: '{"seedance_version":"2.5"}' }), 15);
});

test('Seedance 2.5 sends 30 references, 30 seconds, resolution, ratio and synchronous audio', async (t) => {
  await withArk(t, async ({ db, requests, create }) => {
    create('video', VIDEO);
    const refs = Array.from({ length: 30 }, (_, i) => `https://mock.invalid/ref${i}.png`);
    const result = await videoClient.callVideoApi(db, quiet, { prompt: 'test', model: VIDEO, duration: 30, aspect_ratio: '9:16', resolution: '1080p', reference_urls: refs, voice_reference_url: 'https://mock.invalid/audio.mp3', generate_audio: true, seed: 123, camera_fixed: true });
    assert.equal(result.task_id, 'mock-task');
    const req = requests[0];
    assert.equal(req.url, '/api/v3/contents/generations/tasks');
    assert.equal(req.auth, 'Bearer synthetic-ark-key');
    assert.equal(req.body.content.filter((p) => p.role === 'reference_image').length, 30);
    assert.equal(req.body.content.at(-1).role, 'reference_audio');
    assert.equal(req.body.duration, 30);
    assert.equal(req.body.resolution, '1080p');
    assert.equal(req.body.ratio, '9:16');
    assert.equal(req.body.generate_audio, true);
    for (const key of ['task_type', 'seed', 'camera_fixed']) assert.equal(key in req.body, false);
    const polled = await videoClient.pollVideoTask(db, quiet, null, result.task_id, aiConfigService.listConfigs(db, 'video')[0], 4, 1);
    assert.equal(polled.video_url, 'https://mock.invalid/video.mp4');
    assert.deepEqual(requests.slice(1).map((r) => r.url), Array(3).fill('/api/v3/contents/generations/tasks/mock-task'));
  });
});

test('Seedance 2.5 supports text only, first frame and identical first/last frames; rejects mixed modes and invalid parameters', async (t) => {
  await withArk(t, async ({ db, requests, create }) => {
    create('video', VIDEO, { settings: '{"generate_audio":false}' });
    const base = { prompt: 'test', model: VIDEO };
    await videoClient.callVideoApi(db, quiet, base);
    assert.equal(requests[0].body.content.length, 1);
    assert.equal(requests[0].body.duration, -1);
    assert.equal(requests[0].body.generate_audio, false);
    assert.equal(requests[0].body.ratio, 'adaptive');
    await videoClient.callVideoApi(db, quiet, { ...base, voice_reference_url: 'https://mock.invalid/audio.mp3', generate_audio: true });
    assert.equal(requests.at(-1).body.content[1].role, 'reference_audio');
    for (const last of [undefined, 'https://mock.invalid/first.png']) {
      await videoClient.callVideoApi(db, quiet, { ...base, first_frame_url: 'https://mock.invalid/first.png', last_frame_url: last, aspect_ratio: '9:16', duration: 25 });
      const body = requests.at(-1).body;
      assert.equal(body.ratio, 'adaptive');
      assert.deepEqual(body.content.slice(1).map((p) => p.role), last ? ['first_frame', 'last_frame'] : ['first_frame']);
      assert.equal(body.duration, 25);
    }
    for (const [options, error] of [
      [{ last_frame_url: 'https://mock.invalid/last.png' }, /首帧/],
      [{ first_frame_url: 'https://mock.invalid/first.png', reference_urls: ['https://mock.invalid/ref.png'] }, /混用/],
      [{ resolution: '4k' }, /分辨率/],
      [{ aspect_ratio: '2:3' }, /画幅/],
      [{ generate_audio: 'false' }, /布尔/],
      [{ reference_urls: Array(31).fill('https://mock.invalid/ref.png') }, /30/],
    ]) {
      const before = requests.length;
      await assert.rejects(videoClient.callVideoApi(db, quiet, { ...base, ...options }), error);
      assert.equal(requests.length, before);
    }
  });
});

test('Seedance 2.5 works with the existing classic protocol while 2.0 retains its request behavior', async (t) => {
  await withArk(t, async ({ db, requests, create }) => {
    create('video', VIDEO, { api_protocol: 'volcengine' });
    await videoClient.callVideoApi(db, quiet, { prompt: 'test', model: VIDEO, image_url: 'https://mock.invalid/first.png', duration: 25, aspect_ratio: '9:16' });
    assert.equal(requests.at(-1).body.content[1].role, 'first_frame');
    assert.equal(requests.at(-1).body.ratio, 'adaptive');
    create('video', OLD_VIDEO);
    await videoClient.callVideoApi(db, quiet, { prompt: 'test', model: OLD_VIDEO, duration: 30, aspect_ratio: '9:16', reference_urls: Array.from({ length: 10 }, (_, i) => `https://mock.invalid/${i}.png`) });
    const body = requests.at(-1).body;
    assert.equal(body.duration, 15);
    assert.equal(body.content.length, 10);
    assert.equal(body.ratio, '9:16');
    assert.equal(body.task_type, 'i2v');
    const drama = require('../src/services/dramaService').createDrama(db, quiet, { title: 'Voice reference mock' });
    db.prepare('INSERT INTO characters (drama_id, name, seedance2_voice_asset, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(drama.id, 'Mock actor', JSON.stringify({ status: 'active', url: 'https://mock.invalid/audio.mp3' }), new Date().toISOString(), new Date().toISOString());
    for (const model of [VIDEO, OLD_VIDEO]) {
      await videoClient.callVideoApi(db, quiet, { prompt: 'test', model, drama_id: drama.id, first_frame_url: 'https://mock.invalid/first.png' });
      assert.equal(requests.at(-1).body.content[1].role, 'first_frame');
      assert.ok(requests.at(-1).body.content.every((part) => part.role !== 'reference_audio'));
    }
  });
});

test('Seedance polling terminates on failed, cancelled and expired tasks', async (t) => {
  await withArk(t, async ({ db, create, setStatuses }) => {
    const cfg = create('video', VIDEO);
    for (const status of ['failed', 'cancelled', 'expired']) {
      setStatuses([status]);
      const result = await videoClient.pollVideoTask(db, quiet, null, 'mock-task', cfg, 2, 1);
      assert.ok(result.error);
      assert.notEqual(result.error, '??????');
    }
  });
});

test('Western preset creates four empty-key templates, preserves Google/Kling and repeated edits, and defaults new projects only', (t) => {
  const db = makeDb(t);
  const google = aiConfigService.createConfig(db, quiet, { name: 'existing Google', service_type: 'text', provider: 'gemini', base_url: 'https://mock.invalid', model: ['gemini-2.5-pro'], api_key: '' });
  const kling = aiConfigService.createConfig(db, quiet, { name: 'existing Kling', service_type: 'video', provider: 'kling', base_url: 'https://mock.invalid', model: ['kling-v3'], api_key: '' });
  const dramaService = require('../src/services/dramaService');
  const before = dramaService.createDrama(db, quiet, { title: 'Existing' });
  preset.applyPreset(db, quiet);
  const templates = aiConfigService.listConfigs(db).filter((row) => row.name.startsWith('欧美短剧'));
  assert.equal(templates.length, 4);
  assert.ok(templates.every((row) => row.api_key === '' && row.is_default));
  const text = templates.find((row) => row.service_type === 'text');
  assert.equal(text.base_url, 'https://api.deepseek.com');
  assert.equal(text.default_model, 'deepseek-flash');
  aiConfigService.updateConfig(db, quiet, text.id, { api_key: 'synthetic-user-key', model: ['custom-text-model'], default_model: 'custom-text-model' });
  preset.applyPreset(db, quiet);
  assert.equal(aiConfigService.listConfigs(db).length, 6);
  assert.equal(aiConfigService.getConfig(db, text.id).api_key, 'synthetic-user-key');
  assert.equal(aiConfigService.getConfig(db, text.id).default_model, 'custom-text-model');
  assert.ok(aiConfigService.getConfig(db, google.id));
  assert.ok(aiConfigService.getConfig(db, kling.id));
  const created = dramaService.createDrama(db, quiet, { title: 'New' });
  assert.equal(created.style, preset.STYLE);
  assert.equal(created.metadata.aspect_ratio, '9:16');
  assert.equal(created.metadata.script_language, 'en');
  assert.equal(dramaService.getDramaById(db, before.id).style, 'realistic');
  assert.equal(dramaService.createDrama(db, quiet, { title: 'Explicit', style: 'anime style', metadata: { aspect_ratio: '16:9' } }).metadata.aspect_ratio, '16:9');
});

test('Western story prompt is opt-in and preserves the original prompt and JSON schema', async (t) => {
  const aiClient = require('../src/services/aiClient');
  const captured = [];
  t.mock.method(aiClient, 'generateText', async (_db, _log, _type, user, system) => { captured.push({ user, system }); return '[{"episode":1,"title":"Test","content":"Test script"}]'; });
  const generateStory = require('../src/services/storyGenerationService').generateStory;
  await generateStory(null, quiet, { premise: 'A supplied premise', drama_style: 'realistic' });
  await generateStory(null, quiet, { premise: 'A supplied premise', drama_style: preset.STYLE });
  assert.equal(captured[1].system, captured[0].system + '\n\n' + preset.STORY_PROMPT);
  assert.equal(captured[1].user, captured[0].user);
  assert.match(captured[1].system, /natural American English/);
  assert.match(captured[1].system, /60–90 seconds/);
  assert.match(captured[1].system, /first 3 seconds/);
  assert.match(captured[1].system, /cliffhanger/);
});
