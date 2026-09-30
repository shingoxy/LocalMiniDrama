const aiConfigService = require('./aiConfigService');
const settingsService = require('./settingsService');

const STYLE = 'western short drama';
const STORY_PROMPT = `Western short drama preset:
Write for a US / English-speaking audience on TikTok, YouTube Shorts and Instagram Reels.
Use natural American English for titles, dialogue and narrative content. Avoid literal translations and translated-Chinese-drama phrasing.
Each episode should run 60–90 seconds, with a strong hook in the first 3 seconds, fast-paced action and dialogue, and a strong cliffhanger ending.
Expand only the user's supplied premise; preserve the required JSON schema and episode count.`;
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const CONFIGS = [
  { service_type: 'text', name: '欧美短剧 · DeepSeek 官方', provider: 'deepseek', api_protocol: 'openai', base_url: 'https://api.deepseek.com', model: ['deepseek-flash', 'deepseek-v4-pro'], endpoint: '/chat/completions', settings: JSON.stringify({ deepseek_thinking: 'disabled' }) },
  ...['image', 'storyboard_image'].map((service_type) => ({ service_type, name: `欧美短剧 · Seedream 5.0 Pro · ${service_type === 'image' ? '角色场景' : '分镜'}`, provider: 'volcengine', api_protocol: 'volcengine', base_url: ARK_BASE, model: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-4-5-251128'], endpoint: '/images/generations', settings: JSON.stringify({ seedream_version: '5.0-pro' }) })),
  { service_type: 'video', name: '欧美短剧 · Seedance 2.5', provider: 'volces', api_protocol: 'volcengine_omni', base_url: ARK_BASE, model: ['doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128'], endpoint: '/contents/generations/tasks', query_endpoint: '/contents/generations/tasks/{taskId}', settings: JSON.stringify({ seedance_version: '2.5', generate_audio: true }) },
];
const CREATION_DEFAULTS = { style: STYLE, metadata: { aspect_ratio: '9:16', script_language: 'en', media_language: 'en' } };

// Repeated clicks select the existing templates without overwriting keys or user-edited models.
function applyPreset(db, log) {
  return db.transaction(() => {
    for (const template of CONFIGS) {
      const existing = aiConfigService.listConfigs(db, template.service_type).find((row) => row.name === template.name);
      if (existing) aiConfigService.updateConfig(db, log, existing.id, { is_default: true, is_active: true });
      else aiConfigService.createConfig(db, log, { ...template, api_key: '', default_model: template.model[0], priority: 10, is_default: true });
    }
    settingsService.setGlobalSetting(db, 'creation_defaults', CREATION_DEFAULTS);
    return { preset: STYLE, creation_defaults: CREATION_DEFAULTS };
  })();
}

module.exports = { STYLE, STORY_PROMPT, CONFIGS, CREATION_DEFAULTS, applyPreset };
