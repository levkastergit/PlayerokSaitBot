async function handlePartnersGetOwnerList({ deps, currentUserId }) {
  const { getPartnersForOwner } = deps
  if (!currentUserId || !Number.isFinite(Number(currentUserId))) {
    return { statusCode: 401, data: { error: 'Unauthorized' } }
  }

  const ownerId = Number(currentUserId)
  const rows = getPartnersForOwner.all(ownerId) || []

  return {
    statusCode: 200,
    data: {
      list: rows.map((r) => ({
        partnerId: Number(r.partner_user_id),
        connectStatus: Number(r.connect_status),
        createdAt: r.created_at != null ? Number(r.created_at) : null,
      })),
    },
  }
}

module.exports = { handlePartnersGetOwnerList }

