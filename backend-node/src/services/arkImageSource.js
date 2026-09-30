const crypto = require('crypto');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

function isOfficialArkConfig(config) {
  try {
    const url = new URL(config.base_url);
    return url.protocol === 'https:' && /^ark\.[a-z0-9-]+\.volces\.com$/i.test(url.hostname);
  } catch (_) { return false; }
}

function arkKeyFingerprint(config) {
  const key = String(config?.api_key || '').trim();
  return key && isOfficialArkConfig(config) ? crypto.createHash('sha256').update(key).digest('hex') : null;
}

function imageResponseMetadata(config, model, data, imageUrl, referenceCount) {
  const created = Number(data.created);
  return {
    provider: config.provider,
    model: data.model || model,
    original_url: /^https?:\/\//i.test(imageUrl) ? imageUrl : null,
    generated_at: created > 0 && Number.isFinite(new Date(created * 1000).getTime())
      ? new Date(created * 1000).toISOString() : new Date().toISOString(),
    generation_mode: referenceCount ? 'image_to_image' : 'text_to_image',
    ark_key_fingerprint: arkKeyFingerprint(config),
  };
}

function saveImageResponseMetadata(db, imageGenId, result) {
  if (!result.generated_at) return;
  db.prepare(`UPDATE image_generations SET provider = ?, model = ?, original_url = ?,
    generated_at = ?, generation_mode = ?, ark_key_fingerprint = ? WHERE id = ?`).run(
    result.provider, result.model, result.original_url, result.generated_at,
    result.generation_mode, result.ark_key_fingerprint, imageGenId
  );
}

// Match only local storage URLs/paths, or an exact recorded public URL; never match a third-party /static/ URL by path.
function localImagePath(input, opts) {
  let value = String(input || '').replace(/\\/g, '/');
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const base = opts.files_base_url ? new URL(opts.files_base_url) : null;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin !== base?.origin) return '';
      value = decodeURIComponent(url.pathname);
    } else if (path.isAbsolute(value) && opts.storage_local_path && !value.startsWith('/static/')) {
      value = path.relative(opts.storage_local_path, value).replace(/\\/g, '/');
    }
  } catch (_) { return ''; }
  return value.replace(/^\/?static\//, '').replace(/^\/+/, '').split('?')[0];
}

function safeImageLabel(input) {
  const value = String(input || '');
  if (value.startsWith('data:')) return '(base64 image)';
  return value.split('?')[0];
}

function applyTrustedArkImages(db, config, opts, now = Date.now()) {
  const out = { ...opts, seedance_image_sources: [] };
  const fingerprint = arkKeyFingerprint(config);
  const rewrite = (input) => {
    if (!input) return input;
    const raw = String(input).trim();
    let row;
    if (!raw.startsWith('asset://') && !raw.startsWith('data:')) {
      try {
        row = db.prepare(`SELECT * FROM image_generations WHERE deleted_at IS NULL AND status = 'completed'
          AND (image_url = ? OR original_url = ? OR (? <> '' AND local_path = ?)) ORDER BY id DESC LIMIT 1`)
          .get(raw, raw, localImagePath(raw, opts), localImagePath(raw, opts));
      } catch (err) {
        // Older minimal databases in tests may not have image records/provenance yet.
        if (!/no such (table|column)/i.test(err.message)) throw err;
      }
    }
    const age = row?.generated_at ? now - Date.parse(row.generated_at) : NaN;
    let reason = 'ordinary_image';
    let selected = raw;
    const seedream5 = /seedream[-_.]?5[-_.]?0[-_.]?(lite|pro)(?:[-_.]|$)/i.test(row?.model || '');
    if (row && seedream5) {
      reason = 'unverified_ark_source';
      if (row.generation_mode !== 'text_to_image') reason = 'not_text_to_image';
      else if (!Number.isFinite(age) || age < 0 || age >= 30 * DAY_MS) reason = 'outside_trusted_period';
      else if (!fingerprint || !/^[a-f0-9]{64}$/.test(row.ark_key_fingerprint || '')) reason = 'unverified_ark_source';
      else if (!/^https:\/\//i.test(row.original_url || '')) reason = 'missing_original_url';
      else {
        // The API download URL lasts 24 h; 30 days is the separate material trust window.
        // Never silently replace an expired original with a proxy/Base64 copy.
        if (age >= DAY_MS) throw new Error(`Seedream 图片 #${row.id} 原始 URL 已超过 24 小时下载有效期；请重新生成，或使用官方 TOS 保存的原始产物。可信素材期限为 30 天，不能延长下载链接有效期。`);
        selected = row.original_url;
        // Different keys may belong to the same Ark account. Preserve the original URL
        // and let Ark enforce account ownership; do not claim local verification in this case.
        reason = row.ark_key_fingerprint === fingerprint ? 'ark_trusted_original' : 'ark_original_account_unverified';
      }
    }
    out.seedance_image_sources.push({
      selected_url: selected,
      source_input: safeImageLabel(raw),
      image_gen_id: row?.id || null,
      storyboard_id: row?.storyboard_id || null,
      local_path: row?.local_path || null,
      provider: row?.provider || null,
      model: row?.model || null,
      generation_mode: row?.generation_mode || null,
      generated_at: row?.generated_at || null,
      source_kind: raw.startsWith('asset://') ? 'authorized_asset' : reason,
    });
    return selected;
  };
  for (const field of ['image_url', 'first_frame_url', 'last_frame_url', 'first_frame_local_path', 'last_frame_local_path']) {
    if (opts[field]) out[field] = rewrite(opts[field]);
  }
  if (Array.isArray(opts.reference_urls)) out.reference_urls = opts.reference_urls.map(rewrite);
  return out;
}

function logSeedanceImageSources(log, opts, body, inputUrls) {
  let imageIndex = 0;
  body.content.forEach((part, index) => {
    if (part.type !== 'image_url') return;
    const input = inputUrls[imageIndex++];
    const source = opts.seedance_image_sources?.find((item) => item.selected_url === input);
    const { selected_url, ...details } = source || {};
    log.info('[Seedance] content 图片素材对应关系', {
      video_gen_id: opts.video_gen_id,
      content_index: index,
      content_field: `content[${index}]`,
      role: part.role,
      ...details,
      submitted_url: safeImageLabel(part.image_url.url),
    });
  });
}

module.exports = { imageResponseMetadata, saveImageResponseMetadata, applyTrustedArkImages, logSeedanceImageSources };
