// Google API 专用代理约束与 HTTP/HTTPS CONNECT 隧道服务（零外部依赖）
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const settingsService = require('./settingsService');
const { registerSecret } = require('../utils/redactSecrets');

const SETTING_KEY = 'google_proxy';
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_TEST_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  protocol: 'https',
  host: '',
  port: '',
  username: '',
  password: '',
});

const MISSING_PROXY_ERROR =
  '访问 Google API 已默认约束必须走代理，请先在「AI 配置 → Google 代理」中配置代理地址并保存';

// 进程内缓存，供未显式传入 db 的底层请求函数读取；由启动加载与保存动作实时同步
let runtimeConfig = { ...DEFAULT_CONFIG };

/** 判断主机名是否属于本机回环地址 */
function isLocalHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/** 判断目标 URL 是否指向 Google API / Google 媒体下载域名 */
function isGoogleUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || isLocalHostname(host)) return false;
  return (
    host === 'generativelanguage.googleapis.com' ||
    host.endsWith('.googleapis.com') ||
    host.endsWith('.googleusercontent.com') ||
    host === 'ai.google.dev' ||
    host.endsWith('.ai.google.dev') ||
    host === 'google.com' ||
    host.endsWith('.google.com')
  );
}

/** 注册代理密码与 Basic 认证串到日志脱敏集合 */
function registerProxySecrets(cfg) {
  if (!cfg) return;
  if (cfg.password) registerSecret(cfg.password);
  if (cfg.username || cfg.password) {
    const basic = Buffer.from(`${cfg.username || ''}:${cfg.password || ''}`, 'utf8').toString('base64');
    registerSecret(basic);
  }
}

/** 解析并规范化代理输入（支持在 host 中直接粘贴带协议/端口/账号密码的完整 URL） */
function normalizeProxyInput(input = {}, existing = DEFAULT_CONFIG) {
  const prev = { ...DEFAULT_CONFIG, ...(existing || {}) };
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : Boolean(prev.enabled);
  let protocol = String(input.protocol !== undefined ? input.protocol : prev.protocol || 'https')
    .trim()
    .toLowerCase()
    .replace(/:\/\//g, '')
    .replace(/:$/, '');
  let host = String(input.host !== undefined ? input.host : prev.host || '').trim();
  let port = input.port !== undefined ? String(input.port).trim() : String(prev.port || '').trim();
  let username = String(input.username !== undefined ? input.username : prev.username || '').trim();
  let password;

  if (input.clear_password === true) {
    password = '';
  } else if (input.password !== undefined && String(input.password) !== '') {
    password = String(input.password);
  } else {
    password = String(prev.password || '');
  }

  // 兼容用户在主机框里直接粘贴完整代理 URL（如 https://user:pass@127.0.0.1:7890）
  if (host.includes('://')) {
    let parsed;
    try {
      parsed = new URL(host);
    } catch (_) {
      throw new Error('代理地址格式无效，请填写主机名或完整代理 URL');
    }
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`当前仅支持 HTTPS / HTTP 代理，暂不支持 ${scheme}://`);
    }
    protocol = scheme;
    host = parsed.hostname;
    if (parsed.port) port = parsed.port;
    if (parsed.username && !username) username = decodeURIComponent(parsed.username);
    if (parsed.password && !input.password && input.clear_password !== true) {
      password = decodeURIComponent(parsed.password);
    }
  } else if (host && !port) {
    // 兼容 host:port 写法（排除裸 IPv6）
    const colonIdx = host.lastIndexOf(':');
    if (colonIdx > 0 && host.indexOf(':') === colonIdx) {
      const maybePort = host.slice(colonIdx + 1);
      if (/^\d+$/.test(maybePort)) {
        host = host.slice(0, colonIdx).trim();
        port = maybePort;
      }
    }
  }

  // 去掉误输入的尾部斜杠
  host = host.replace(/\/+$/, '');

  if (protocol !== 'https' && protocol !== 'http') {
    throw new Error('代理协议仅支持 https 或 http');
  }

  if (host) {
    if (!port) {
      throw new Error('请填写代理端口（1-65535）');
    }
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error('代理端口需为 1-65535 之间的整数');
    }
    port = String(portNum);
  } else {
    port = '';
  }

  const normalized = { enabled, protocol, host, port, username, password };
  registerProxySecrets(normalized);
  return normalized;
}

/** 从环境变量解析备用 HTTP/HTTPS 代理 */
function parseEnvProxy() {
  const raw = (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  ).trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') return null;
    const port = Number(parsed.port || (protocol === 'https' ? 443 : 80));
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const proxy = {
      protocol,
      host: parsed.hostname,
      port,
      username: parsed.username ? decodeURIComponent(parsed.username) : '',
      password: parsed.password ? decodeURIComponent(parsed.password) : '',
    };
    registerProxySecrets(proxy);
    return proxy;
  } catch (_) {
    return null;
  }
}

/** 读取完整内部配置（含密码，仅供后端发起请求使用，切勿直接返回前端） */
function getRawConfig(db) {
  if (!db) return { ...runtimeConfig };
  const stored = settingsService.getGlobalSetting(db, SETTING_KEY, null);
  const merged = stored && typeof stored === 'object'
    ? { ...DEFAULT_CONFIG, ...stored }
    : { ...DEFAULT_CONFIG };
  registerProxySecrets(merged);
  return merged;
}

/** 启动时从数据库同步代理配置到内存缓存 */
function initFromDb(db) {
  const cfg = getRawConfig(db);
  runtimeConfig = cfg;
  return cfg;
}

/** 构造返回给前端的安全配置对象（绝不暴露密码明文） */
function toPublicConfig(rawCfg) {
  const cfg = { ...DEFAULT_CONFIG, ...(rawCfg || {}) };
  const envProxy = parseEnvProxy();
  return {
    enabled: Boolean(cfg.enabled),
    protocol: cfg.protocol === 'http' ? 'http' : 'https',
    host: cfg.host || '',
    port: cfg.port ? String(cfg.port) : '',
    username: cfg.username || '',
    has_password: Boolean(cfg.password),
    is_configured: Boolean(cfg.host && cfg.port),
    has_env_fallback: Boolean(envProxy),
    env_proxy_preview: envProxy ? `${envProxy.protocol}://${envProxy.host}:${envProxy.port}` : '',
  };
}

function getPublicConfig(db) {
  const cfg = getRawConfig(db);
  runtimeConfig = cfg;
  return toPublicConfig(cfg);
}

function saveConfig(db, input) {
  const existing = getRawConfig(db);
  const next = normalizeProxyInput(input, existing);
  settingsService.setGlobalSetting(db, SETTING_KEY, next);
  runtimeConfig = next;
  return toPublicConfig(next);
}

/** 解析当前应对 Google 请求生效的代理策略 */
function resolveGoogleProxy(db = null, overrideConfig = null) {
  const cfg = overrideConfig
    ? { ...DEFAULT_CONFIG, ...overrideConfig }
    : (db ? getRawConfig(db) : { ...runtimeConfig });

  if (!cfg.enabled) {
    return { mode: 'direct', proxy: null };
  }
  if (cfg.host && cfg.port) {
    return {
      mode: 'configured',
      proxy: {
        protocol: cfg.protocol === 'http' ? 'http' : 'https',
        host: cfg.host,
        port: Number(cfg.port),
        username: cfg.username || '',
        password: cfg.password || '',
      },
    };
  }
  const envProxy = parseEnvProxy();
  if (envProxy) {
    return { mode: 'env', proxy: envProxy };
  }
  return { mode: 'missing', proxy: null };
}

/** 生成更易排查的代理连接报错 */
function formatProxyError(proxy, err) {
  const msg = String(err?.message || err || '未知网络错误');
  const lower = msg.toLowerCase();
  if (
    proxy.protocol === 'https' &&
    (lower.includes('wrong version number') ||
      lower.includes('packet length too long') ||
      lower.includes('ssl3_get_record') ||
      lower.includes('eproto') ||
      lower.includes('before secure tls connection'))
  ) {
    return new Error(
      `HTTPS 代理 TLS 握手失败（${proxy.host}:${proxy.port}）：${msg}。提示：若你的本机代理端口未开启 TLS（如常见明文代理端口），请将代理协议切换为 HTTP`
    );
  }
  if (lower.includes('self signed') || lower.includes('self_signed') || lower.includes('unable to verify')) {
    return new Error(`HTTPS 代理证书校验失败（${proxy.host}:${proxy.port}）：${msg}`);
  }
  return new Error(`连接 Google 代理失败（${proxy.protocol}://${proxy.host}:${proxy.port}）：${msg}`);
}

/** 建立到代理服务器的 HTTP/HTTPS CONNECT 隧道，返回已打通目标主机的原始 socket */
function openConnectTunnel(proxy, targetHost, targetPort, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, proxyTlsOptions = {}) {
  return new Promise((resolve, reject) => {
    const authority = `${targetHost}:${targetPort}`;
    const headers = { Host: authority };
    if (proxy.username || proxy.password) {
      const token = Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`, 'utf8').toString('base64');
      headers['Proxy-Authorization'] = `Basic ${token}`;
    }

    const family = net.isIP(proxy.host) === 6 ? 6 : 4;
    let settled = false;
    const done = (err, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(socket);
    };

    // 使用独立单次 Agent 并覆写 createConnection，既保证 HTTPS 代理走 tls.connect，又避免被 NODE_USE_ENV_PROXY 劫持
    const proxyDialAgent = new http.Agent({ keepAlive: false });
    proxyDialAgent.createConnection = () => {
      if (proxy.protocol === 'https') {
        return tls.connect({
          host: proxy.host,
          port: Number(proxy.port),
          servername: net.isIP(proxy.host) ? undefined : proxy.host,
          rejectUnauthorized: proxyTlsOptions.rejectUnauthorized ?? true,
          family,
        });
      }
      return net.connect({
        host: proxy.host,
        port: Number(proxy.port),
        family,
      });
    };

    const req = http.request({
      host: proxy.host,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: proxyDialAgent,
    });

    const timer = setTimeout(() => {
      req.destroy();
      done(new Error(`连接 Google 代理超时（${proxy.protocol}://${proxy.host}:${proxy.port}，${timeoutMs}ms）`));
    }, timeoutMs);

    req.on('connect', (proxyRes, socket, head) => {
      if (proxyRes.statusCode === 407) {
        socket.destroy();
        return done(new Error('Google 代理认证失败 (HTTP 407)，请检查代理用户名和密码'));
      }
      if (proxyRes.statusCode !== 200) {
        socket.destroy();
        return done(new Error(`Google 代理隧道建立失败 (HTTP ${proxyRes.statusCode})`));
      }
      if (head && head.length > 0) {
        socket.unshift(head);
      }
      done(null, socket);
    });

    req.on('error', (err) => {
      done(formatProxyError(proxy, err));
    });

    req.end();
  });
}

/** 创建支持 HTTP/HTTPS 代理（含账号密码认证）的 Node Agent */
function createConnectProxyAgent(proxy, { isHttpsTarget = true, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, targetTlsOptions = {}, proxyTlsOptions = {} } = {}) {
  const BaseAgent = isHttpsTarget ? https.Agent : http.Agent;
  const agent = new BaseAgent({ keepAlive: false });

  agent.createConnection = function createProxyConnection(options, callback) {
    const targetHost = options.hostname || options.host;
    const targetPort = Number(options.port || (isHttpsTarget ? 443 : 80));

    openConnectTunnel(proxy, targetHost, targetPort, connectTimeoutMs, proxyTlsOptions)
      .then((tunnelSocket) => {
        if (!isHttpsTarget) {
          callback(null, tunnelSocket);
          return;
        }
        const tlsSocket = tls.connect({
          socket: tunnelSocket,
          servername: options.servername || (net.isIP(targetHost) ? undefined : targetHost),
          rejectUnauthorized: targetTlsOptions.rejectUnauthorized ?? (options.rejectUnauthorized !== false),
        });
        // 内层 TLS 关闭时同步释放外层 CONNECT 隧道，避免长连接残留
        tlsSocket.once('close', () => {
          if (!tunnelSocket.destroyed) tunnelSocket.destroy();
        });
        callback(null, tlsSocket);
      })
      .catch((err) => {
        callback(err);
      });
    return null;
  };

  return agent;
}

/**
 * 为 Node http/https.request 解析 Google 代理 Agent。
 * - 非 Google 目标：返回 undefined（保持直连或默认行为）
 * - Google 目标且约束开启但未配置代理：抛出明确错误，阻止直连
 * - Google 目标且已配置代理：返回专用 CONNECT Proxy Agent
 */
function getAgentForUrl(rawUrl, db = null, options = {}) {
  const forceProxy = Boolean(options.forceProxy);
  if (!forceProxy && !isGoogleUrl(rawUrl)) return undefined;

  const resolved = resolveGoogleProxy(db, options.proxyConfig || null);
  if (resolved.mode === 'missing') {
    throw new Error(MISSING_PROXY_ERROR);
  }
  if (resolved.mode === 'direct') {
    return undefined;
  }

  const parsed = new URL(rawUrl);
  return createConnectProxyAgent(resolved.proxy, {
    isHttpsTarget: parsed.protocol === 'https:',
    connectTimeoutMs: options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
    targetTlsOptions: options.targetTlsOptions || {},
    proxyTlsOptions: options.proxyTlsOptions || {},
  });
}

/** 通过指定 Agent 执行单次 HTTP/HTTPS 请求，返回与 fetch Response 兼容的对象 */
function requestViaAgent(rawUrl, init = {}, agent, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const method = String(init.method || 'GET').toUpperCase();
    const headers = { ...(init.headers || {}) };
    const hasConnection = Object.keys(headers).some((k) => k.toLowerCase() === 'connection');
    if (!hasConnection) headers.Connection = 'close';

    let bodyBuf = null;
    if (init.body != null) {
      if (Buffer.isBuffer(init.body)) bodyBuf = init.body;
      else if (typeof init.body === 'string') bodyBuf = Buffer.from(init.body, 'utf8');
      else if (init.body instanceof Uint8Array) bodyBuf = Buffer.from(init.body);
      else bodyBuf = Buffer.from(String(init.body), 'utf8');

      const hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
      if (!hasContentLength) headers['Content-Length'] = bodyBuf.length;
    }

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          const respHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers || {})) {
            if (Array.isArray(v)) {
              for (const item of v) respHeaders.append(k, item);
            } else if (v !== undefined) {
              respHeaders.set(k, String(v));
            }
          }
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage || '',
            headers: respHeaders,
            async text() {
              return buf.toString('utf8');
            },
            async json() {
              return JSON.parse(buf.toString('utf8'));
            },
            async arrayBuffer() {
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            },
          });
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Google 代理请求超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * 面向 fetch 调用点的 Google 代理包装函数：
 * - 非 Google URL：直接透传 global.fetch
 * - Google URL：强制走已配置的 Google 代理（或未配置时抛出约束错误）
 */
async function fetchWithGoogleProxy(rawUrl, init = {}, db = null, options = {}) {
  const urlStr = typeof rawUrl === 'string' ? rawUrl : rawUrl.toString();
  const agent = getAgentForUrl(urlStr, db, options);
  if (!agent) {
    return fetch(rawUrl, init);
  }
  const timeoutMs = Number(options.timeoutMs || 120000);
  return requestViaAgent(urlStr, init, agent, timeoutMs);
}

/** 测试通过指定代理访问 Google API 的连通性（不消耗任何模型额度） */
async function testGoogleProxy(db, candidateInput = null, testOptions = {}) {
  const existing = getRawConfig(db);
  const candidate = candidateInput
    ? normalizeProxyInput({ ...candidateInput, enabled: true }, existing)
    : { ...existing, enabled: true };

  if (!candidate.host || !candidate.port) {
    throw new Error('请先填写代理主机地址和端口后再测试');
  }

  const targetUrl = testOptions.targetUrl || DEFAULT_TEST_URL;
  const startedAt = Date.now();
  const res = await fetchWithGoogleProxy(
    targetUrl,
    { method: 'GET', headers: { Accept: 'application/json' } },
    db,
    {
      forceProxy: true,
      proxyConfig: candidate,
      timeoutMs: testOptions.timeoutMs || 15000,
      connectTimeoutMs: testOptions.connectTimeoutMs || 15000,
      targetTlsOptions: testOptions.targetTlsOptions || {},
      proxyTlsOptions: testOptions.proxyTlsOptions || {},
    }
  );
  // 读完响应体确保连接正常释放
  await res.text().catch(() => '');
  const latencyMs = Date.now() - startedAt;
  const proxySummary = `${candidate.protocol}://${candidate.host}:${candidate.port}${candidate.username ? '（已启用账密认证）' : ''}`;
  return {
    ok: true,
    status: res.status,
    latency_ms: latencyMs,
    proxy_summary: proxySummary,
    message: `代理连通成功（Google 返回 HTTP ${res.status}，耗时 ${latencyMs}ms）`,
  };
}

module.exports = {
  SETTING_KEY,
  DEFAULT_CONFIG,
  MISSING_PROXY_ERROR,
  isGoogleUrl,
  normalizeProxyInput,
  getRawConfig,
  getPublicConfig,
  saveConfig,
  initFromDb,
  resolveGoogleProxy,
  createConnectProxyAgent,
  getAgentForUrl,
  fetchWithGoogleProxy,
  testGoogleProxy,
};
