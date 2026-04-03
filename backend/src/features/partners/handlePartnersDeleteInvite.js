async function handlePartnersDeleteInvite({ payload, deps, currentUserId }) {
  const { deleteInvite } = deps

  const partnerIdRaw = payload?.partnerId
  const partnerId = partnerIdRaw != null ? Number(partnerIdRaw) : null

  if (!Number.isFinite(partnerId)) {
    return { statusCode: 400, data: { error: 'Некорректный ID напарника' } }
  }
  if (!currentUserId || !Number.isFinite(Number(currentUserId))) {
    return { statusCode: 401, data: { error: 'Unauthorized' } }
  }

  deleteInvite.run(Number(currentUserId), partnerId)
  return { statusCode: 200, data: { ok: true } }
}

module.exports = { handlePartnersDeleteInvite }

