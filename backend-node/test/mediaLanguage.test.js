const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const media = require('../src/services/mediaLanguage');
const ai = require('../src/services/aiClient');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function fixture(t, metadata = { media_language: 'en', script_language: 'zh' }, style = 'realistic') {
  const db = new Database(':memory:');
  require('../src/db/migrate').runMigrationsAndEnsure(db);
  db.prepare('INSERT INTO dramas (id, title, style, metadata) VALUES (1, ?, ?, ?)').run('Mock', style, JSON.stringify(metadata));
  t.after(() => db.close());
  return db;
}

test('English media is independent of Chinese screenplay; ordinary projects remain unchanged', async (t) => {
  const db = fixture(t);
  const translate = t.mock.method(ai, 'generateText', async () => '{"prompt":"Close-up of a MISSING poster for Frank Miller."}');
  const result = await media.translateMediaTexts(db, quiet, 1, { prompt: '寻人启事：弗兰克·米勒' });
  assert.match(result.prompt, /MISSING/);
  assert.equal(JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = 1').get().metadata).script_language, 'zh');
  db.prepare('UPDATE dramas SET metadata = ? WHERE id = 1').run('{"script_language":"zh"}');
  assert.deepEqual(await media.translateMediaTexts(db, quiet, 1, { prompt: '中文提示词' }), { prompt: '中文提示词' });
  assert.equal(translate.mock.callCount(), 1);
});

test('Western preset defaults to English media, with an explicit opt-out', (t) => {
  const db = fixture(t, {}, 'western short drama');
  assert.equal(media.isEnglishMedia(db, 1), true);
  db.prepare('UPDATE dramas SET metadata = ? WHERE id = 1').run('{"media_language":"auto"}');
  assert.equal(media.isEnglishMedia(db, 1), false);
  assert.equal(require('../src/services/westernShortDramaPreset').CREATION_DEFAULTS.metadata.media_language, 'en');
});

test('Translation preserves Seedance machine references and rejects Chinese or lost references', async (t) => {
  const db = fixture(t);
  t.mock.method(ai, 'generateText', async (db, log, type, prompt) => {
    const input = JSON.parse(prompt);
    assert.match(input.prompt, /__MEDIA_REF_0__/);
    return '{"prompt":"Use __MEDIA_REF_0__ for the character and __MEDIA_REF_1__ for sound."}';
  });
  const result = await media.translateMediaTexts(db, quiet, 1, { prompt: '人物参考@图片1，声音参考@音频1' });
  assert.equal(result.prompt, 'Use @图片1 for the character and @音频1 for sound.');
  for (const raw of ['{"prompt":"仍然中文"}', '{"prompt":"Missing anchor"}', '{"other":"Hello"}', 'invalid JSON']) {
    t.mock.method(ai, 'generateText', async () => raw);
    await assert.rejects(media.translateMediaTexts(db, quiet, 1, { prompt: '参考@图片1' }), /英文转换/);
  }
});

test('Seedream -> Seedance requests use English prompts, preserve trusted URLs and request audio', async (t) => {
  const db = fixture(t);
  const configs = require('../src/services/aiConfigService');
  const IMAGE = 'doubao-seedream-5-0-pro-260628';
  const VIDEO = 'doubao-seedance-2-5-260628';
  const original = 'https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/english.png?signature=original';
  for (const [service_type, model] of [['image', IMAGE], ['video', VIDEO]]) configs.createConfig(db, quiet, {
    name: 'Mock', service_type, model: [model], provider: 'volcengine', api_key: 'mock-key',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3', is_default: true,
    api_protocol: service_type === 'image' ? 'volcengine' : 'volcengine_omni',
  });
  t.mock.method(ai, 'generateText', async (db, log, type, prompt) => JSON.stringify(Object.fromEntries(
    Object.entries(JSON.parse(prompt)).map(([key, value]) => [key, value ? 'A close-up of a MISSING poster for Frank Miller.' : ''])
  )));
  const requests = [];
  t.mock.method(ai, 'postJSONWithTimeout', async (url, headers, body) => {
    requests.push({ kind: 'image', body });
    return { statusCode: 200, raw: JSON.stringify({ model: IMAGE, created: Math.floor(Date.now() / 1000), data: [{ url: original }] }) };
  });
  delete require.cache[require.resolve('../src/services/imageClient')];
  const result = await require('../src/services/imageClient').callImageApi(db, quiet, { drama_id: 1, prompt: '寻人启事特写', model: IMAGE });
  const source = require('../src/services/arkImageSource');
  const metadata = source.imageResponseMetadata(configs.listConfigs(db, 'image')[0], IMAGE, {}, result.original_url, 0);
  db.prepare(`INSERT INTO image_generations (drama_id, status, provider, model, image_url, local_path,
    original_url, generated_at, generation_mode, ark_key_fingerprint) VALUES (1, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(metadata.provider, metadata.model, '/static/images/english.png', 'images/english.png', metadata.original_url, metadata.generated_at, metadata.generation_mode, metadata.ark_key_fingerprint);
  t.mock.method(require('../src/config'), 'loadConfig', () => ({ image_proxy: { use_for_video: true, upload_url: 'https://mock.invalid/proxy' }, style: {} }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
    requests.push({ kind: 'video', body: JSON.parse(options.body) });
    return new Response('{"id":"mock-task"}', { status: 200 });
  });
  await require('../src/services/videoClient').callVideoApi(db, quiet, { drama_id: 1, prompt: '聚焦寻人启事文字', model: VIDEO, reference_urls: ['http://localhost:5679/static/images/english.png'], files_base_url: 'http://localhost:5679/static' });
  assert.equal(requests.length, 2);
  assert.equal(/\p{Script=Han}/u.test(requests[0].body.prompt), false);
  assert.match(requests[0].body.prompt, /American English/);
  assert.equal(/\p{Script=Han}/u.test(requests[1].body.content[0].text), false);
  assert.match(requests[1].body.content[0].text, /spoken dialogue/);
  assert.equal(requests[1].body.content[1].image_url.url, original);
  assert.equal(requests[1].body.generate_audio, true);
  t.mock.method(ai, 'generateText', async () => '{"prompt":"中文未转换"}');
  await assert.rejects(require('../src/services/videoClient').callVideoApi(db, quiet, { drama_id: 1, prompt: '中文', model: VIDEO }), /英文转换/);
  assert.equal(requests.length, 2);
});
