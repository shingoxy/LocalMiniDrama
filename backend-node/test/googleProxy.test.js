const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const googleProxyService = require('../src/services/googleProxyService');
const aiConfigService = require('../src/services/aiConfigService');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const { redactSecrets } = require('../src/utils/redactSecrets');
const settingsRoutes = require('../src/routes/settings');

const quiet = { info() {}, warn() {}, error() {}, errorw() {}, infow() {}, warnw() {} };

function createTestDb() {
  const db = new Database(':memory:');
  require('../src/db/migrate').runMigrationsAndEnsure(db);
  return db;
}

function withClearedProxyEnv(fn) {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  const restore = () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

/** 启动本地 HTTP CONNECT 代理测试桩（支持校验 Basic 用户名密码） */
async function startMockConnectProxy({ expectedAuth = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end('CONNECT only');
  });
  server.on('connect', (req, clientSocket, head) => {
    seen.push({ url: req.url, proxyAuth: req.headers['proxy-authorization'] || null });
    if (expectedAuth && req.headers['proxy-authorization'] !== expectedAuth) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const [targetHost, targetPort] = String(req.url || '').split(':');
    const upstream = net.connect(Number(targetPort), targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('Google 域名判定只约束 Google API/媒体域，不影响国内与本机地址', () => {
  assert.equal(googleProxyService.isGoogleUrl('https://generativelanguage.googleapis.com/v1beta/models'), true);
  assert.equal(googleProxyService.isGoogleUrl('https://storage.googleapis.com/bucket/video.mp4'), true);
  assert.equal(googleProxyService.isGoogleUrl('https://lh3.googleusercontent.com/abc'), true);
  assert.equal(googleProxyService.isGoogleUrl('https://ai.google.dev/api'), true);

  assert.equal(googleProxyService.isGoogleUrl('https://api.deepseek.com/chat/completions'), false);
  assert.equal(googleProxyService.isGoogleUrl('https://ark.cn-beijing.volces.com/api/v3/images/generations'), false);
  assert.equal(googleProxyService.isGoogleUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'), false);
  assert.equal(googleProxyService.isGoogleUrl('http://127.0.0.1:8188/prompt'), false);
  assert.equal(googleProxyService.isGoogleUrl('http://localhost:5679/health'), false);
});

test('默认配置启用 Google 代理且默认协议为 https，未配置代理时阻止直连 Google', async () => {
  await withClearedProxyEnv(async () => {
    const db = createTestDb();
    try {
      const pub = googleProxyService.getPublicConfig(db);
      assert.equal(pub.enabled, true);
      assert.equal(pub.protocol, 'https');
      assert.equal(pub.is_configured, false);
      assert.equal(pub.has_password, false);
      assert.equal('password' in pub, false);

      assert.throws(
        () => googleProxyService.getAgentForUrl('https://generativelanguage.googleapis.com/v1beta/models', db),
        /必须走代理/
      );
      await assert.rejects(
        () => googleProxyService.fetchWithGoogleProxy('https://generativelanguage.googleapis.com/v1beta/models', {}, db),
        /必须走代理/
      );

      // 非 Google 域名不受影响
      assert.equal(googleProxyService.getAgentForUrl('https://api.deepseek.com/chat/completions', db), undefined);
    } finally {
      db.close();
    }
  });
});

test('代理配置支持粘贴完整 URL、保留/清除密码、禁止不支持协议且严格脱敏', () => {
  const db = createTestDb();
  try {
    const saved = googleProxyService.saveConfig(db, {
      enabled: true,
      host: 'https://proxyUser:SuperSecretPass99!@127.0.0.1:8443',
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.protocol, 'https');
    assert.equal(saved.host, '127.0.0.1');
    assert.equal(saved.port, '8443');
    assert.equal(saved.username, 'proxyUser');
    assert.equal(saved.has_password, true);
    assert.equal('password' in saved, false);

    // 脱敏校验：密码、Basic token 及内联 URL 密码都不会泄露
    const basicToken = Buffer.from('proxyUser:SuperSecretPass99!', 'utf8').toString('base64');
    const redacted = redactSecrets(`err SuperSecretPass99! Basic ${basicToken} https://proxyUser:SuperSecretPass99!@127.0.0.1:8443`);
    assert.equal(redacted.includes('SuperSecretPass99!'), false);
    assert.equal(redacted.includes(basicToken), false);

    // 只改端口不传密码时保留原密码
    const updated = googleProxyService.saveConfig(db, { port: '9443' });
    assert.equal(updated.port, '9443');
    assert.equal(updated.has_password, true);
    assert.equal(googleProxyService.getRawConfig(db).password, 'SuperSecretPass99!');

    // 显式清除密码
    const cleared = googleProxyService.saveConfig(db, { clear_password: true });
    assert.equal(cleared.has_password, false);
    assert.equal(googleProxyService.getRawConfig(db).password, '');

    // 拒绝不支持的协议与非法端口
    assert.throws(() => googleProxyService.saveConfig(db, { host: 'socks5://127.0.0.1:1080' }), /暂不支持 socks5/);
    assert.throws(() => googleProxyService.saveConfig(db, { host: '127.0.0.1', port: '99999' }), /1-65535/);
  } finally {
    db.close();
  }
});

test('HTTP CONNECT 代理支持用户名/密码认证并拦截 407 与协议错配', async () => {
  const targetServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url, key: req.headers['x-goog-api-key'] || null }));
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const targetPort = targetServer.address().port;

  const expectedAuth = 'Basic ' + Buffer.from('alice:p@ss:word', 'utf8').toString('base64');
  const proxy = await startMockConnectProxy({ expectedAuth });
  const db = createTestDb();

  try {
    // 1) 正确用户名和密码通过 CONNECT 隧道请求成功
    googleProxyService.saveConfig(db, {
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: String(proxy.port),
      username: 'alice',
      password: 'p@ss:word',
    });

    const okRes = await googleProxyService.fetchWithGoogleProxy(
      `http://127.0.0.1:${targetPort}/v1beta/models`,
      { method: 'GET', headers: { 'x-goog-api-key': 'synthetic-k' } },
      db,
      { forceProxy: true }
    );
    assert.equal(okRes.status, 200);
    const json = await okRes.json();
    assert.equal(json.ok, true);
    assert.equal(json.key, 'synthetic-k');
    assert.equal(proxy.seen.length, 1);
    assert.equal(proxy.seen[0].proxyAuth, expectedAuth);

    // 2) testGoogleProxy 可复用已保存密码完成测试
    const testResult = await googleProxyService.testGoogleProxy(
      db,
      { protocol: 'http', host: '127.0.0.1', port: String(proxy.port), username: 'alice' },
      { targetUrl: `http://127.0.0.1:${targetPort}/v1beta/models` }
    );
    assert.equal(testResult.ok, true);
    assert.equal(testResult.status, 200);

    // 3) 错误密码返回明确的 HTTP 407 认证失败提示
    await assert.rejects(
      () => googleProxyService.testGoogleProxy(
        db,
        { protocol: 'http', host: '127.0.0.1', port: String(proxy.port), username: 'alice', password: 'wrong' },
        { targetUrl: `http://127.0.0.1:${targetPort}/v1beta/models` }
      ),
      /HTTP 407/
    );

    // 4) 对明文 HTTP 代理误选 HTTPS 协议时给出切换 HTTP 提示
    await assert.rejects(
      () => googleProxyService.testGoogleProxy(
        db,
        { protocol: 'https', host: '127.0.0.1', port: String(proxy.port), username: 'alice', password: 'p@ss:word' },
        { targetUrl: `http://127.0.0.1:${targetPort}/v1beta/models` }
      ),
      /请将代理协议切换为 HTTP/
    );
  } finally {
    db.close();
    await proxy.close();
    await new Promise((resolve) => targetServer.close(resolve));
  }
});

test('settings 路由读写 Google 代理接口不泄露明文密码', () => {
  const db = createTestDb();
  try {
    const handlers = settingsRoutes(db, {}, quiet);
    let payload;
    const res = { status() { return this; }, json(v) { payload = v; } };

    handlers.updateGoogleProxy({
      body: { enabled: true, protocol: 'https', host: 'proxy.local', port: 8443, username: 'u1', password: 'secret-route-password' },
    }, res);
    assert.equal(payload.success, true);
    assert.equal(payload.data.host, 'proxy.local');
    assert.equal(payload.data.port, '8443');
    assert.equal(payload.data.has_password, true);
    assert.equal(JSON.stringify(payload).includes('secret-route-password'), false);

    handlers.getGoogleProxy({}, res);
    assert.equal(payload.data.username, 'u1');
    assert.equal(payload.data.has_password, true);
    assert.equal(JSON.stringify(payload).includes('secret-route-password'), false);
  } finally {
    db.close();
  }
});

test('HTTPS (TLS) 代理支持嵌套 TLS 隧道与账密认证', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-tls-proxy-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  const cnfPath = path.join(tmpDir, 'openssl.cnf');
  fs.writeFileSync(
    cnfPath,
    '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=127.0.0.1\n',
    'utf8'
  );
  const gen = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-config', cnfPath,
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  if (gen.status !== 0 || !fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    t.skip('openssl 不可用，跳过本地自签名 TLS 代理测试');
    return;
  }

  const tlsOpts = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  const activeSockets = new Set();
  const trackSocket = (s) => {
    activeSockets.add(s);
    s.once('close', () => activeSockets.delete(s));
  };
  const targetServer = https.createServer(tlsOpts, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, tlsTarget: true, url: req.url }));
  });
  targetServer.on('secureConnection', trackSocket);
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const targetPort = targetServer.address().port;

  const expectedAuth = 'Basic ' + Buffer.from('tlsUser:tlsPass#123', 'utf8').toString('base64');
  let seenAuth = null;
  const tlsProxy = https.createServer(tlsOpts, (req, res) => {
    res.writeHead(405);
    res.end();
  });
  tlsProxy.on('secureConnection', trackSocket);
  tlsProxy.on('connect', (req, clientSocket, head) => {
    trackSocket(clientSocket);
    seenAuth = req.headers['proxy-authorization'] || null;
    if (seenAuth !== expectedAuth) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const [h, p] = String(req.url || '').split(':');
    const upstream = net.connect(Number(p), h, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    trackSocket(upstream);
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => tlsProxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = tlsProxy.address().port;
  const db = createTestDb();

  try {
    googleProxyService.saveConfig(db, {
      enabled: true,
      protocol: 'https',
      host: '127.0.0.1',
      port: String(proxyPort),
      username: 'tlsUser',
      password: 'tlsPass#123',
    });

    const result = await googleProxyService.testGoogleProxy(
      db,
      null,
      {
        targetUrl: `https://127.0.0.1:${targetPort}/v1beta/models`,
        timeoutMs: 5000,
        connectTimeoutMs: 5000,
        proxyTlsOptions: { rejectUnauthorized: false },
        targetTlsOptions: { rejectUnauthorized: false },
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(seenAuth, expectedAuth);
  } finally {
    db.close();
    for (const s of activeSockets) s.destroy();
    tlsProxy.closeAllConnections?.();
    targetServer.closeAllConnections?.();
    await new Promise((resolve) => tlsProxy.close(resolve));
    await new Promise((resolve) => targetServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('在线拉取模型列表支持 Google Gemini 分类筛选与 OpenAI 兼容端点', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1beta/models')) {
      assert.equal(req.headers['x-goog-api-key'], 'synthetic-gemini-list-key');
      res.end(JSON.stringify({
        models: [
          { name: 'models/gemini-3-flash-preview', displayName: 'Gemini 3 Flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3-pro-image-preview', displayName: 'Gemini 3 Pro Image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-omni-1.1-flash', displayName: 'Gemini Omni 1.1 Flash', supportedGenerationMethods: [] },
          { name: 'models/veo-3.1-generate-preview', displayName: 'Veo 3.1', supportedGenerationMethods: ['predictLongRunning'] },
          { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
        ],
      }));
      return;
    }
    if (req.url === '/v1/models') {
      assert.equal(req.headers.authorization, 'Bearer synthetic-openai-list-key');
      res.end(JSON.stringify({
        data: [
          { id: 'deepseek-v4-pro' },
          { id: 'deepseek-flash' },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const db = createTestDb();

  try {
    // Gemini 文本（从 /v1beta/openai 自动还原到 /v1beta/models）
    const geminiText = await aiConfigService.fetchAvailableModels({
      provider: 'gemini',
      service_type: 'text',
      base_url: `http://127.0.0.1:${port}/v1beta/openai`,
      api_key: 'synthetic-gemini-list-key',
    }, db);
    assert.equal(geminiText.source, 'gemini');
    assert.equal(geminiText.total, 5);
    assert.equal(geminiText.recommended_count, 1);
    assert.equal(geminiText.models[0].id, 'gemini-3-flash-preview');
    assert.equal(geminiText.models[0].recommended, true);

    // Gemini 图片
    const geminiImg = await aiConfigService.fetchAvailableModels({
      provider: 'gemini',
      service_type: 'image',
      base_url: `http://127.0.0.1:${port}`,
      api_key: 'synthetic-gemini-list-key',
    }, db);
    assert.equal(geminiImg.recommended_count, 1);
    assert.equal(geminiImg.models[0].id, 'gemini-3-pro-image-preview');

    // Gemini 视频（同时推荐 Omni Flash 与历史 Veo）
    const geminiVid = await aiConfigService.fetchAvailableModels({
      provider: 'gemini',
      service_type: 'video',
      base_url: `http://127.0.0.1:${port}`,
      api_key: 'synthetic-gemini-list-key',
    }, db);
    assert.equal(geminiVid.recommended_count, 2);
    assert.deepEqual(
      geminiVid.models.filter((m) => m.recommended).map((m) => m.id),
      ['gemini-omni-1.1-flash', 'veo-3.1-generate-preview']
    );

    // OpenAI 兼容
    const openaiList = await aiConfigService.fetchAvailableModels({
      provider: 'deepseek',
      service_type: 'text',
      base_url: `http://127.0.0.1:${port}/v1`,
      api_key: 'synthetic-openai-list-key',
    }, db);
    assert.equal(openaiList.source, 'openai');
    assert.deepEqual(openaiList.models.map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  } finally {
    db.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Gemini Omni Flash 视频走 Interactions API，支持首尾帧时长上限、异步轮询与内联 base64 落盘', async () => {
  const seenRequests = [];
  let interactionPollCount = 0;
  let filePollCount = 0;
  const fakeVideoPayload = Buffer.from('synthetic-omni-mp4-payload-12345', 'utf8');
  const fakeVideoB64 = fakeVideoPayload.toString('base64');

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/v1beta/interactions') {
      assert.equal(req.headers['x-goog-api-key'], 'synthetic-omni-key');
      const body = JSON.parse(raw);
      seenRequests.push(body);

      if (body.model === 'gemini-omni-1.1-flash' && Array.isArray(body.input)) {
        // 首尾帧测试：返回 files URI
        res.end(JSON.stringify({
          id: 'v1_sync_1',
          status: 'completed',
          output_video: { uri: 'files/omni_vid_1' },
        }));
        return;
      }
      if (body.model === 'gemini-omni-1.2-flash') {
        // 异步测试：返回 in_progress
        res.end(JSON.stringify({
          id: 'v1_async_1',
          status: 'in_progress',
        }));
        return;
      }
      // 内联 base64 同步返回测试
      res.end(JSON.stringify({
        id: 'v1_inline_1',
        status: 'completed',
        outputs: [{ type: 'video', mime_type: 'video/mp4', data: fakeVideoB64 }],
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1beta/files/omni_vid_1') {
      assert.equal(req.headers['x-goog-api-key'], 'synthetic-omni-key');
      res.end(JSON.stringify({ name: 'files/omni_vid_1', state: 'ACTIVE' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1beta/files/omni_vid_pending') {
      filePollCount += 1;
      res.end(JSON.stringify({
        name: 'files/omni_vid_pending',
        state: filePollCount >= 2 ? 'ACTIVE' : 'PROCESSING',
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1beta/interactions/v1_async_1') {
      assert.equal(req.headers['x-goog-api-key'], 'synthetic-omni-key');
      interactionPollCount += 1;
      if (interactionPollCount < 2) {
        res.end(JSON.stringify({ id: 'v1_async_1', status: 'in_progress' }));
        return;
      }
      res.end(JSON.stringify({
        id: 'v1_async_1',
        status: 'completed',
        steps: [{ content: [{ type: 'video', mime_type: 'video/mp4', data: fakeVideoB64 }] }],
      }));
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = createTestDb();
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-omni-video-'));
  const configModule = require('../src/config');
  const oldLoadConfig = configModule.loadConfig;

  try {
    const cfg = aiConfigService.createConfig(db, quiet, {
      name: 'Google Gemini Omni Flash 视频',
      service_type: 'video',
      provider: 'gemini',
      api_protocol: 'gemini',
      base_url: base,
      model: ['gemini-omni-1.1-flash', 'gemini-omni-1.2-flash'],
      default_model: 'gemini-omni-1.1-flash',
      api_key: 'synthetic-omni-key',
      is_default: true,
    });

    // 1) 首尾帧过渡：时长 12s 被裁剪为 10s，9:16 竖屏、1080p，携带两张内联图片与首尾帧提示
    const flRes = await videoClient.callVideoApi(db, quiet, {
      prompt: 'A crane shot from sunrise to dusk',
      model: 'gemini-omni-1.1-flash',
      duration: 12,
      aspect_ratio: '9:16',
      resolution: '1080p',
      first_frame_url: 'data:image/png;base64,iVBORw0KGgo=',
      last_frame_url: 'data:image/jpeg;base64,/9j/4AAQ',
      video_gen_id: 1,
    });
    assert.equal(flRes.video_url, `${base}/v1beta/files/omni_vid_1:download?alt=media`);
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0].response_format.type, 'video');
    assert.equal(seenRequests[0].response_format.aspect_ratio, '9:16');
    assert.equal(seenRequests[0].response_format.duration, '10s');
    assert.equal(seenRequests[0].response_format.resolution, '1080p');
    assert.equal(seenRequests[0].response_format.delivery, 'uri');
    assert.equal(seenRequests[0].input.length, 3);
    assert.equal(seenRequests[0].input[0].type, 'image');
    assert.equal(seenRequests[0].input[0].mime_type, 'image/png');
    assert.equal(seenRequests[0].input[1].type, 'image');
    assert.equal(seenRequests[0].input[1].mime_type, 'image/jpeg');
    assert.match(seenRequests[0].input[2].text, /starting frame.*final frame/i);

    // 2) 异步 interaction 轮询与 omni_file PROCESSING 轮询
    const asyncRes = await videoClient.callVideoApi(db, quiet, {
      prompt: 'Ocean waves at sunset',
      model: 'gemini-omni-1.2-flash',
      duration: 15,
      aspect_ratio: '16:9',
      video_gen_id: 2,
    });
    assert.equal(asyncRes.task_id, 'interaction:v1_async_1');
    assert.equal(seenRequests[1].response_format.duration, '15s');

    const polledInteraction = await videoClient.pollVideoTask(db, quiet, 2, 'interaction:v1_async_1', cfg, 5, 10);
    assert.equal(polledInteraction.video_url, `data:video/mp4;base64,${fakeVideoB64}`);
    assert.equal(interactionPollCount, 2);

    const polledFile = await videoClient.pollVideoTask(db, quiet, 2, 'omni_file:omni_vid_pending', cfg, 5, 10);
    assert.equal(polledFile.video_url, `${base}/v1beta/files/omni_vid_pending:download?alt=media`);
    assert.equal(filePollCount, 2);

    // 3) processVideoGeneration 收到内联 base64 视频后落盘为本地 mp4，数据库存 /static/... 而非原始 base64
    configModule.loadConfig = () => ({ storage: { local_path: storageDir, base_url: 'http://127.0.0.1:5679/static' } });
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO video_generations (drama_id, provider, model, prompt, status, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)'
    ).run('gemini', 'gemini-omni-1.1-flash', 'Inline test', 'pending', now, now);
    const vgId = Number(insert.lastInsertRowid);
    await videoService.processVideoGeneration(db, quiet, vgId);

    const row = db.prepare('SELECT status, video_url, local_path FROM video_generations WHERE id = ?').get(vgId);
    assert.equal(row.status, 'completed');
    assert.ok(row.local_path && row.local_path.endsWith('.mp4'));
    assert.equal(row.video_url, '/static/' + row.local_path);
    assert.equal(row.video_url.startsWith('data:'), false);
    const savedBytes = fs.readFileSync(path.join(storageDir, row.local_path));
    assert.deepEqual(savedBytes, fakeVideoPayload);
  } finally {
    configModule.loadConfig = oldLoadConfig;
    db.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
