const { sendJson } = require('./sendJson')
const { readJsonBody } = require('./readJsonBody')

// Маршруты Partner Redemption (ChatGPT). Только приватные (по сессии):
//   GET  /api/partner-gpt/settings  — что сконфигурировано
//   POST /api/partner-gpt/settings  — сохранить/очистить ключ ogp_live_...
// Вебхуков у этого API нет — выдача идёт через опрос (см. partnerGptClient).
async function dispatchPartnerGpt({ req, res, pathname, currentUserId, deps = {} }) {
  if (!pathname.startsWith('/api/partner-gpt/')) return false
  if (currentUserId == null) return false

  if (req.method === 'GET' && pathname === '/api/partner-gpt/settings') {
    const meta =
      typeof deps.getPartnerGptSettingsMeta === 'function'
        ? deps.getPartnerGptSettingsMeta(currentUserId)
        : { configured: false, updatedAt: null }
    return sendJson(res, 200, { ...meta, updated_at: meta.updatedAt ?? null }) || true
  }

  if (req.method === 'POST' && pathname === '/api/partner-gpt/settings') {
    if (typeof deps.savePartnerGptApiKey !== 'function') {
      return sendJson(res, 500, { error: 'Server misconfiguration' }) || true
    }
    const payload = await readJsonBody(req, { fallback: {} })
    const clear = payload && payload.clear === true
    const raw = payload && Object.prototype.hasOwnProperty.call(payload, 'apiKey') ? payload.apiKey : null
    const apiKey = clear ? '' : raw == null ? null : String(raw || '').trim()
    if (apiKey === null) {
      return sendJson(res, 400, { error: 'apiKey is required (or clear: true)' }) || true
    }
    try {
      const saved = deps.savePartnerGptApiKey(currentUserId, apiKey)
      return sendJson(res, 200, {
        ok: true,
        configured: Boolean(saved.configured),
        updated_at: saved.updatedAt ?? null,
      }) || true
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to save Partner GPT API key', details: err?.message || String(err) }) || true
    }
  }

  return false
}

module.exports = { dispatchPartnerGpt }
