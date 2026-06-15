async function handlePartnersGetWorkerList({ deps, currentUserId }) {
  const { getDirectorsForWorker } = deps
  if (!currentUserId || !Number.isFinite(Number(currentUserId))) {
    return { statusCode: 401, data: { error: 'Unauthorized' } }
  }

  const workerId = Number(currentUserId)
  const rows = getDirectorsForWorker.all(workerId) || []

  return {
    statusCode: 200,
    data: {
      list: rows.map((r) => ({
        directorId: Number(r.director_user_id),
        login: r.director_login != null ? String(r.director_login) : null,
        connectStatus: Number(r.connect_status),
        createdAt: r.created_at != null ? Number(r.created_at) : null,
      })),
    },
  }
}

module.exports = { handlePartnersGetWorkerList }

