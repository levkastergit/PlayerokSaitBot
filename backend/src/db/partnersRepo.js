function setupPartnersRepo(db) {
  const upsertInvite = db.prepare(`
    INSERT INTO partner_invites (owner_user_id, worker_user_id, invite_password_hash, connect_status, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(owner_user_id, worker_user_id) DO UPDATE SET
      invite_password_hash = excluded.invite_password_hash,
      connect_status = 1,
      updated_at = excluded.updated_at
  `)

  const deleteInvite = db.prepare(`
    DELETE FROM partner_invites
    WHERE owner_user_id = ? AND worker_user_id = ?
  `)

  const getInvite = db.prepare(`
    SELECT id, invite_password_hash, connect_status, created_at, updated_at
    FROM partner_invites
    WHERE owner_user_id = ? AND worker_user_id = ?
  `)

  const confirmConnect = db.prepare(`
    UPDATE partner_invites
    SET connect_status = 2, updated_at = ?
    WHERE id = ?
  `)

  const getPartnersForOwner = db.prepare(`
    SELECT
      pi.worker_user_id AS partner_user_id,
      pi.connect_status,
      pi.created_at,
      u.login AS partner_login
    FROM partner_invites pi
    LEFT JOIN users u ON u.id = pi.worker_user_id
    WHERE pi.owner_user_id = ?
    ORDER BY pi.created_at DESC
  `)

  const getDirectorsForWorker = db.prepare(`
    SELECT
      pi.owner_user_id AS director_user_id,
      pi.connect_status,
      pi.created_at,
      u.login AS director_login
    FROM partner_invites pi
    LEFT JOIN users u ON u.id = pi.owner_user_id
    WHERE pi.worker_user_id = ?
    ORDER BY pi.created_at DESC
  `)

  return {
    upsertInvite,
    deleteInvite,
    getInvite,
    confirmConnect,
    getPartnersForOwner,
    getDirectorsForWorker,
  }
}

module.exports = { setupPartnersRepo }

