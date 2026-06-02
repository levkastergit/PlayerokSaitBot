// Кэш официальных курсов USD→RUB ЦБ РФ по датам. Глобальный (одинаков для всех
// пользователей), поэтому без user_id. date — 'YYYY-MM-DD' (эффективная дата запроса),
// rate — рублей за 1 USD.
function createUsdRatesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usd_rates (
      date TEXT PRIMARY KEY,
      rate REAL NOT NULL,
      fetched_at INTEGER NOT NULL DEFAULT 0
    )
  `)
}

module.exports = { createUsdRatesTable }
