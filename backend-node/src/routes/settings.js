const settingsService = require('../services/settingsService');
const googleProxyService = require('../services/googleProxyService');
const response = require('../response');
const { loadConfig } = require('../config');
const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');

function getLanguage(cfg) {
  return (req, res) => {
    const language = settingsService.getLanguage(cfg);
    response.success(res, { language });
  };
}

function updateLanguage(cfg, log) {
  return (req, res) => {
    const lang = req.body?.language;
    if (lang !== 'zh' && lang !== 'en') {
      return response.badRequest(res, '语言参数错误，只支持 zh 或 en');
    }
    const out = settingsService.updateLanguage(cfg, log, lang);
    if (!out.ok) return response.badRequest(res, out.error);
    const message = lang === 'en' ? 'Language switched to English' : '语言已切换为中文';
    response.success(res, { message, language: lang });
  };
}

/** GET /settings/generation — 获取生成相关全局设置 */
function getGenerationSettings(db) {
  return (req, res) => {
    const concurrency = settingsService.getGlobalSetting(db, 'pipeline_concurrency', 3);
    const video_concurrency = settingsService.getGlobalSetting(db, 'pipeline_video_concurrency', 3);
    const video_generation_timeout_minutes = resolveVideoGenerationTimeoutMinutes(loadConfig());
    const creation_defaults = settingsService.getGlobalSetting(db, 'creation_defaults', null);
    response.success(res, { concurrency, video_concurrency, video_generation_timeout_minutes, creation_defaults });
  };
}

/** PUT /settings/generation — 更新生成相关全局设置 */
function updateGenerationSettings(db) {
  return (req, res) => {
    const { concurrency, video_concurrency } = req.body || {};
    if (concurrency !== undefined) {
      const n = Number(concurrency);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return response.badRequest(res, '图片并发数需为 1-20 之间的整数');
      }
      settingsService.setGlobalSetting(db, 'pipeline_concurrency', n);
    }
    if (video_concurrency !== undefined) {
      const n = Number(video_concurrency);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return response.badRequest(res, '视频并发数需为 1-20 之间的整数');
      }
      settingsService.setGlobalSetting(db, 'pipeline_video_concurrency', n);
    }
    const saved = settingsService.getGlobalSetting(db, 'pipeline_concurrency', 3);
    const saved_video = settingsService.getGlobalSetting(db, 'pipeline_video_concurrency', 3);
    const video_generation_timeout_minutes = resolveVideoGenerationTimeoutMinutes(loadConfig());
    response.success(res, {
      concurrency: saved,
      video_concurrency: saved_video,
      video_generation_timeout_minutes,
    });
  };
}

/** GET /settings/google-proxy — 获取 Google API 代理配置（不返回密码明文） */
function getGoogleProxy(db) {
  return (req, res) => {
    response.success(res, googleProxyService.getPublicConfig(db));
  };
}

/** PUT /settings/google-proxy — 保存 Google API 代理配置 */
function updateGoogleProxy(db, log) {
  return (req, res) => {
    try {
      const saved = googleProxyService.saveConfig(db, req.body || {});
      log.info('Google proxy config updated', {
        enabled: saved.enabled,
        protocol: saved.protocol,
        host: saved.host,
        port: saved.port,
        has_username: Boolean(saved.username),
        has_password: saved.has_password,
      });
      response.success(res, saved);
    } catch (err) {
      return response.badRequest(res, err.message || '代理配置参数无效');
    }
  };
}

/** POST /settings/google-proxy/test — 测试 Google API 代理连通性（不消耗模型额度） */
function testGoogleProxy(db, log) {
  return async (req, res) => {
    try {
      const result = await googleProxyService.testGoogleProxy(db, req.body || {});
      log.info('Google proxy connectivity test passed', {
        status: result.status,
        latency_ms: result.latency_ms,
        proxy: result.proxy_summary,
      });
      response.success(res, result);
    } catch (err) {
      log.warn('Google proxy connectivity test failed', { error: err.message });
      return response.badRequest(res, err.message || '代理连通性测试失败');
    }
  };
}

module.exports = function settingsRoutes(db, cfg, log) {
  return {
    getLanguage: getLanguage(cfg),
    updateLanguage: updateLanguage(cfg, log),
    getGenerationSettings: getGenerationSettings(db),
    updateGenerationSettings: updateGenerationSettings(db),
    getGoogleProxy: getGoogleProxy(db),
    updateGoogleProxy: updateGoogleProxy(db, log),
    testGoogleProxy: testGoogleProxy(db, log),
  };
};
