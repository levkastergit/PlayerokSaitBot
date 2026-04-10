function setupChatSnapshotsRepo(db) {
  const getChatSnapshot = db.prepare(`
    SELECT payload, updated_at
    FROM chat_snapshots
    WHERE user_id = ? AND cache_key = ?
  `)

  const upsertChatSnapshot = db.prepare(`
    INSERT INTO chat_snapshots (user_id, cache_key, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, cache_key) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `)

  const deleteExpiredChatSnapshots = db.prepare(`
    DELETE FROM chat_snapshots
    WHERE updated_at < ?
  `)

  return {
    getChatSnapshot,
    upsertChatSnapshot,
    deleteExpiredChatSnapshots,
  }
}

module.exports = { setupChatSnapshotsRepo }

