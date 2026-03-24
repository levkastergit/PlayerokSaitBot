function setupProductSettingsRepo(db) {
  const getSettings = db.prepare(`
    SELECT settings, updated_at FROM product_settings
    WHERE user_id = ? AND product_key = ?
  `)

  const getAllSettings = db.prepare(`
    SELECT product_key, settings FROM product_settings
    WHERE user_id = ?
  `)

  const upsertSettings = db.prepare(`
    INSERT INTO product_settings (user_id, product_key, settings, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, product_key) DO UPDATE SET
      settings = excluded.settings,
      updated_at = excluded.updated_at
  `)

  const deleteSettings = db.prepare(`
    DELETE FROM product_settings WHERE user_id = ? AND product_key = ?
  `)

  return { getSettings, getAllSettings, upsertSettings, deleteSettings }
}

module.exports = { setupProductSettingsRepo }

