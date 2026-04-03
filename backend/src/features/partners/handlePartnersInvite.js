async function handlePartnersInvite({ payload, deps, currentUserId }) {
  const { upsertInvite, hashPassword } = deps

  const partnerIdRaw = payload?.partnerId
  const passwordRaw = payload?.password
  const partnerId = partnerIdRaw != null ? Number(partnerIdRaw) : null
  const password = passwordRaw != null ? String(passwordRaw) : ''

  if (!Number.isFinite(partnerId)) {
    return { statusCode: 400, data: { error: 'Некорректный ID напарника' } }
  }
  if (!password) {
    return { statusCode: 400, data: { error: 'Введите пароль для напарника' } }
  }
  if (!currentUserId || !Number.isFinite(Number(currentUserId))) {
    return { statusCode: 401, data: { error: 'Unauthorized' } }
  }

  const ownerId = Number(currentUserId)
  if (ownerId === partnerId) {
    return { statusCode: 400, data: { error: 'Нельзя пригласить самого себя' } }
  }

  const now = Math.floor(Date.now() / 1000)
  const passwordHash = hashPassword(password)
  upsertInvite.run(ownerId, partnerId, passwordHash, now, now)

  return { statusCode: 200, data: { ok: true } }
}

module.exports = { handlePartnersInvite }

