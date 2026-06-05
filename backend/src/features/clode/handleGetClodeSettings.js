async function handleGetClodeSettings({ currentUserId, deps }) {
  const { getClodeSettingsMeta } = deps
  if (typeof getClodeSettingsMeta !== 'function') {
    return { statusCode: 500, data: { error: 'Server misconfiguration' } }
  }
  const meta = getClodeSettingsMeta(currentUserId)
  return {
    statusCode: 200,
    data: {
      ok: true,
      configured: Boolean(meta.configured),
      updated_at: meta.updatedAt != null ? meta.updatedAt : null,
    },
  }
}

module.exports = { handleGetClodeSettings }
