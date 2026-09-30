const { createHash } = require('crypto');
const { json } = require('./videoModelSelection');
const DEFAULTS = {
  comfy_url: 'http://127.0.0.1:8188', local_timeout_minutes: 120, retry_multiplier: 1,
  expected_episodes_per_month: 20, subscriptions: [],
  electricity: { enabled: false, power_w: 0, price_per_kwh: 0 },
};
function settings(db) {
  const value = json(db.prepare("SELECT value FROM global_settings WHERE key = 'hybrid_video'").get()?.value);
  return { ...DEFAULTS, ...value, electricity: { ...DEFAULTS.electricity, ...value.electricity } };
}
function nonnegative(v, label, nullable = false) {
  if (nullable && (v == null || v === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(label + ' 必须是非负数字');
  return n;
}
function saveSettings(db, input) {
  const s = { ...settings(db), ...input };
  const u = new URL(s.comfy_url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('ComfyUI 地址必须是无凭据的 HTTP(S) 地址');
  s.comfy_url = u.toString().replace(/\/$/, '');
  if (![1, 1.2, 1.5, 2].includes(Number(s.retry_multiplier))) throw new Error('Retry Multiplier 必须为 1/1.2/1.5/2');
  s.retry_multiplier = Number(s.retry_multiplier);
  s.expected_episodes_per_month = nonnegative(s.expected_episodes_per_month, '每月预期集数');
  if (!s.expected_episodes_per_month) throw new Error('每月预期集数必须大于 0');
  s.local_timeout_minutes = nonnegative(s.local_timeout_minutes, '本地超时');
  if (!s.local_timeout_minutes || s.local_timeout_minutes > 1440) throw new Error('本地超时必须在 1–1440 分钟');
  s.electricity = { enabled: s.electricity?.enabled === true,
    power_w: nonnegative(s.electricity?.power_w, '系统功耗'), price_per_kwh: nonnegative(s.electricity?.price_per_kwh, '电价') };
  if (!Array.isArray(s.subscriptions) || s.subscriptions.length > 20) throw new Error('套餐格式错误');
  s.subscriptions = s.subscriptions.map(p => ({ name: String(p.name || '').slice(0, 100), enabled: p.enabled === true,
    monthly_fee: nonnegative(p.monthly_fee, '月费'), included_quota: nonnegative(p.included_quota, '额度', true),
    quota_unit: ['requests', 'seconds', 'images'].includes(p.quota_unit) ? p.quota_unit : 'requests',
    overage_price: nonnegative(p.overage_price, '超额单价', true), currency: String(p.currency || 'CNY').toUpperCase(),
    provider: String(p.provider || '') }));
  db.prepare("INSERT INTO global_settings(key,value,updated_at) VALUES('hybrid_video',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(JSON.stringify(s), new Date().toISOString());
  return s;
}
function prices(db) { return db.prepare('SELECT * FROM video_cost_prices ORDER BY provider, model, effective_date DESC').all(); }
function savePrices(db, rows) {
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('价格表格式错误');
  const valid = rows.map(r => {
    if (!r.provider || !r.model || !['per_second','per_request','per_image','monthly_subscription','local_compute'].includes(r.billing_type)) throw new Error('模型价格字段错误');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.effective_date) || Number.isNaN(Date.parse(r.effective_date))) throw new Error('价格生效日期无效');
    if (!/^[A-Z]{3}$/.test(r.currency || 'CNY')) throw new Error('币种请使用 CNY/USD 等三位代码');
    return { ...r, price: nonnegative(r.price, '单价', true) };
  });
  db.transaction(() => {
    db.prepare('DELETE FROM video_cost_prices').run();
    const insert = db.prepare('INSERT INTO video_cost_prices(provider,model,billing_type,price,currency,resolution,effective_date) VALUES(?,?,?,?,?,?,?)');
    for (const r of valid) insert.run(r.provider, r.model, r.billing_type, r.price, r.currency || 'CNY', r.resolution || '*', r.effective_date);
  })();
  return prices(db);
}
function rate(db, model, resolution) {
  return db.prepare("SELECT * FROM video_cost_prices WHERE provider = ? AND model = ? AND resolution IN (?, '*') AND effective_date <= ? ORDER BY CASE WHEN resolution = ? THEN 0 ELSE 1 END,effective_date DESC LIMIT 1")
    .get(model.provider, model.model, resolution || '*', new Date().toISOString().slice(0, 10), resolution || '*');
}
function localSpeed(db, resolution) {
  let rows = db.prepare("SELECT generation_elapsed_seconds, output_duration, resolution, generation_metadata FROM video_generations WHERE provider = 'local_comfyui' AND status = 'completed' AND generation_elapsed_seconds > 0 AND output_duration > 0 AND deleted_at IS NULL ORDER BY id DESC LIMIT 30").all();
  if (resolution) rows = rows.filter(r => r.resolution === resolution || json(r.generation_metadata).resolution_key === resolution);
  if (!rows.length) return { seconds_per_output_second: null, samples: 0 };
  return { seconds_per_output_second: rows.reduce((n,r)=>n+r.generation_elapsed_seconds,0) / rows.reduce((n,r)=>n+r.output_duration,0), samples: rows.length };
}
function estimateShot(db, model, duration, resolution, s = settings(db)) {
  const pricing = rate(db, model, resolution);
  const speed = model.local ? localSpeed(db, resolution) : { seconds_per_output_second: null, samples: 0 };
  const compute = speed.seconds_per_output_second == null ? null : duration * speed.seconds_per_output_second;
  let api = model.local ? 0 : null;
  if (!model.local && pricing?.price != null) {
    const units = { per_second: duration, per_request: 1, per_image: 1, monthly_subscription: 0, local_compute: 0 };
    api = pricing.price * units[pricing.billing_type];
  }
  const electricity = !model.local || !s.electricity.enabled ? 0 : compute == null ? null
    : compute / 3600 * s.electricity.power_w / 1000 * s.electricity.price_per_kwh;
  const localCompute = model.local && pricing?.billing_type === 'local_compute' && pricing.price > 0
    ? compute == null ? null : compute / 3600 * pricing.price : 0;
  return { selection: model, duration, resolution: resolution || null, api_cost: api, currency: model.local ? 'CNY' : pricing?.currency || 'CNY',
    estimated_compute_seconds: compute, local_compute_cost: localCompute, local_compute_currency: pricing?.currency || 'CNY',
    electricity_cost: electricity, electricity_settings: s.electricity, local_samples: speed.samples, pricing: pricing || null };
}
function summarize(db, shots, s = settings(db), episodes = 1) {
  const totals = {};
  function bucket(currency) { return totals[currency] ||= { variable_api: 0, subscription_allocation: 0, subscription_overage: 0, local_compute: 0, electricity: 0, unknown_shots: 0, base_total: 0, risk_adjusted_budget: 0 }; }
  const groups = new Map();
  for (const shot of shots) {
    const b = bucket(shot.currency);
    if (shot.api_cost == null) b.unknown_shots++; else b.variable_api += shot.api_cost * episodes;
    if (shot.electricity_cost != null) bucket('CNY').electricity += shot.electricity_cost * episodes;
    if (shot.local_compute_cost != null) bucket(shot.local_compute_currency).local_compute += shot.local_compute_cost * episodes;
    const key = shot.selection.key;
    const group = groups.get(key) || { label: shot.selection.label, local: shot.selection.local, shots: 0, duration: 0, api_cost: 0, currency: shot.currency, compute_seconds: 0, unknown_prices: 0, unknown_compute: false };
    group.shots += episodes; group.duration += shot.duration * episodes;
    if (shot.api_cost == null) group.unknown_prices += episodes; else group.api_cost += shot.api_cost * episodes;
    if (shot.selection.local && shot.estimated_compute_seconds == null) group.unknown_compute = true;
    group.compute_seconds += (shot.estimated_compute_seconds || 0) * episodes;
    groups.set(key, group);
  }
  const warnings = [];
  const monthlyPrices = new Set();
  for (const shot of shots) {
    if (shot.pricing?.billing_type !== 'monthly_subscription' || shot.pricing.price == null || monthlyPrices.has(shot.selection.key)) continue;
    monthlyPrices.add(shot.selection.key);
    if (!s.subscriptions.some(p=>p.enabled && (!p.provider || p.provider===shot.selection.provider))) {
      bucket(shot.currency).subscription_allocation += shot.pricing.price / s.expected_episodes_per_month * episodes;
    }
  }
  for (const p of s.subscriptions.filter(p => p.enabled)) {
    const b = bucket(p.currency);
    b.subscription_allocation += p.monthly_fee / s.expected_episodes_per_month * episodes;
    if (p.included_quota == null) { warnings.push(`${p.name}: included quota 未填写，不能视为无限额度`); continue; }
    // Quota-based variable fees apply only to models billed through a subscription.
    const covered = shots.filter(shot => shot.pricing?.billing_type === 'monthly_subscription' && (!p.provider || shot.selection.provider === p.provider));
    const unit = shot => p.quota_unit === 'seconds' ? shot.duration : 1;
    const predicted = covered.reduce((n,shot)=>n+unit(shot),0) * episodes;
    const month = new Date().toISOString().slice(0,7);
    const history = db.prepare("SELECT provider, duration, cost_metadata FROM video_generations WHERE started_at LIKE ? AND provider <> 'local_comfyui'").all(month + '%');
    const used = history.filter(r => (!p.provider || r.provider === p.provider) && json(r.cost_metadata).pricing?.billing_type === 'monthly_subscription')
      .reduce((n,r)=>n+(p.quota_unit === 'seconds' ? Number(r.duration||0) : 1),0);
    const extra = Math.max(0,used+predicted-p.included_quota)-Math.max(0,used-p.included_quota);
    if (extra && p.overage_price == null) warnings.push(`${p.name}: 超出额度但超额单价未知`);
    else b.subscription_overage += extra * (p.overage_price || 0);
  }
  for (const b of Object.values(totals)) {
    b.base_total = b.variable_api + b.subscription_allocation + b.subscription_overage + b.local_compute + b.electricity;
    // Fixed allocation remains fixed; retry budget changes only variable estimates.
    b.risk_adjusted_budget = b.subscription_allocation + (b.variable_api+b.subscription_overage+b.local_compute+b.electricity)*s.retry_multiplier;
  }
  return { shots, groups: [...groups.values()], totals, warnings, episodes, retry_multiplier: s.retry_multiplier,
    requires_cloud_confirmation: shots.some(shot=>!shot.selection.local),
    incomplete: shots.some(shot=>shot.api_cost == null || shot.electricity_cost == null || shot.local_compute_cost == null) || warnings.length > 0 };
}
function settingsHash(db) { return createHash('sha256').update(JSON.stringify({ settings: settings(db), prices: prices(db) })).digest('hex'); }
function finishRecord(db, id) {
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(id);
  if (!row?.started_at || !['completed','failed','cancelled'].includes(row.status)) return;
  const ended = row.completed_at || new Date().toISOString();
  const elapsed = Math.max(0,(Date.parse(ended)-Date.parse(row.started_at))/1000);
  const metadata = json(row.cost_metadata);
  if (row.provider === 'local_comfyui') {
    metadata.electricity_cost_measured = metadata.electricity_settings?.enabled && row.generation_elapsed_seconds != null
      ? row.generation_elapsed_seconds / 3600 * metadata.electricity_settings.power_w / 1000 * metadata.electricity_settings.price_per_kwh : null;
    db.prepare('UPDATE video_generations SET cost_metadata = ? WHERE id = ?').run(JSON.stringify(metadata),id);
  }
  db.prepare('UPDATE video_generations SET completed_at = ?, elapsed_seconds = ?, calculated_cost = ?, actual_cost = ? WHERE id = ?')
    .run(ended, elapsed, row.estimated_cost, row.provider === 'local_comfyui' ? 0 : null, id);
}
module.exports = { DEFAULTS, settings, saveSettings, prices, savePrices, estimateShot, summarize, settingsHash, localSpeed, finishRecord };
