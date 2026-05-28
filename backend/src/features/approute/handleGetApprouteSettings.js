async function handleGetApprouteSettings({ currentUserId, deps }) {
  const { getApprouteSettingsMeta } = deps
  if (typeof getApprouteSettingsMeta !== 'function') {
    return { statusCode: 500, data: { error: 'Server misconfiguration' } }
  }
  const meta = getApprouteSettingsMeta(currentUserId)
  return {
    statusCode: 200,
    data: {
      ok: true,
      configured: Boolean(meta.configured),
      updated_at: meta.updatedAt != null ? meta.updatedAt : null,
    },
  }
}

module.exports = { handleGetApprouteSettings }
