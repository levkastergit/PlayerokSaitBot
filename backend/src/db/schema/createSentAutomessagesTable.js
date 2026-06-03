// Персистентный журнал отправленных автосообщений: переживает перезапуск сервера и
// устаревание загруженных сообщений (гонки), поэтому надёжно исключает повторную
// отправку одного и того же автосообщения по одной сделке. Ключ — (user, chat, deal, kind).
function createSentAutomessagesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sent_automessages (
      user_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      deal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, chat_id, deal_id, kind)
    )
  `)
}

module.exports = { createSentAutomessagesTable }
