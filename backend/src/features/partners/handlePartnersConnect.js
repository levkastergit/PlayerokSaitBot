async function handlePartnersConnect({ payload, deps, currentUserId }) {
  const { getInvite, verifyPassword, confirmConnect } = deps

  const directorIdRaw = payload?.ownerId
  const passwordRaw = payload?.password

  const directorId = directorIdRaw != null ? Number(directorIdRaw) : null
  const password = passwordRaw != null ? String(passwordRaw) : ''

  if (!Number.isFinite(directorId)) {
    return { statusCode: 400, data: { error: 'Некорректный ID владельца аккаунта' } }
  }
  if (!password) {
    return { statusCode: 400, data: { error: 'Введите пароль' } }
  }
  if (!currentUserId || !Number.isFinite(Number(currentUserId))) {
    return { statusCode: 401, data: { error: 'Unauthorized' } }
  }

  const workerId = Number(currentUserId)
  if (workerId === directorId) {
    return { statusCode: 400, data: { error: 'Нельзя подключаться к самому себе' } }
  }

  const invite = getInvite.get(directorId, workerId)
  if (!invite) {
    return { statusCode: 404, data: { error: 'Приглашение не найдено' } }
  }

  const passOk = verifyPassword(password, invite.invite_password_hash)
  if (!passOk) {
    return { statusCode: 401, data: { error: 'Неверный пароль' } }
  }

  if (Number(invite.connect_status) !== 2) {
    const now = Math.floor(Date.now() / 1000)
    confirmConnect.run(now, invite.id)
  }

  return {
    statusCode: 200,
    data: {
      ok: true,
      directorId,
      connectStatus: 2,
    },
  }
}

module.exports = { handlePartnersConnect }

