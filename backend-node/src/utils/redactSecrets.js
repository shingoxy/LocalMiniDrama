const secrets = new Set();

function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 4) secrets.add(value);
}

function redactSecrets(value) {
  let text = String(value);
  for (const secret of secrets) {
    text = text.split(secret).join('[REDACTED]');
    text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return text
    .replace(/([?&](?:key|api_key|token|access_token)=)[^\s&"']+/gi, '$1[REDACTED]')
    .replace(/("(?:api_key|apiKey|secret_key|kling_secret_key|authorization|x-goog-api-key)"\s*:\s*")[^"]*/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+\/-]+/g, '$1 [REDACTED]');
}

module.exports = { registerSecret, redactSecrets };
