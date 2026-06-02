'use strict'

// Сервис курса USD→RUB по официальным данным ЦБ РФ с кэшем в БД (таблица usd_rates).
// ЦБ отдаёт эффективный курс на любую дату (выходные/праздники — последний
// опубликованный), поэтому отдельной обработки выходных не требуется.

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp'
const FETCH_TIMEOUT_MS = 8000
const FETCH_CONCURRENCY = 4

/** unix-секунды → 'YYYY-MM-DD' по локальной дате (как в handleProfitStats). */
function ymdFromUnix(unixSec) {
  const d = new Date(Number(unixSec) * 1000)
  if (!Number.isFinite(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function ymdToCbrParam(ymd) {
  const [y, m, d] = String(ymd).split('-')
  return `${d}/${m}/${y}`
}

function parseUsdFromCbrXml(xml) {
  const block = String(xml || '').match(/<Valute ID="R01235">([\s\S]*?)<\/Valute>/)
  if (!block) return null
  const nomM = block[1].match(/<Nominal>(\d+)<\/Nominal>/)
  const valM = block[1].match(/<Value>([\d.,]+)<\/Value>/)
  if (!valM) return null
  const nominal = nomM ? parseInt(nomM[1], 10) || 1 : 1
  const value = parseFloat(String(valM[1]).replace(/\s/g, '').replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null
  const rate = value / nominal
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

function setupUsdRateService(db) {
  const selectStmt = db.prepare('SELECT rate FROM usd_rates WHERE date = ?')
  const upsertStmt = db.prepare(`
    INSERT INTO usd_rates (date, rate, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at
  `)
  const latestStmt = db.prepare('SELECT rate FROM usd_rates ORDER BY date DESC LIMIT 1')

  function getCachedRate(ymd) {
    if (!ymd) return null
    const row = selectStmt.get(ymd)
    return row && Number.isFinite(row.rate) ? row.rate : null
  }

  function getLatestCachedRate() {
    const row = latestStmt.get()
    return row && Number.isFinite(row.rate) ? row.rate : null
  }

  async function fetchRateFromCbr(ymd) {
    const url = `${CBR_URL}?date_req=${encodeURIComponent(ymdToCbrParam(ymd))}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/xml' } })
      if (!res.ok) return null
      const xml = await res.text()
      return parseUsdFromCbrXml(xml)
    } catch (_) {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Гарантирует наличие курсов на указанные даты (тянет недостающие с ЦБ и кэширует).
   * Возвращает map 'YYYY-MM-DD' → rate. Если ЦБ недоступен для даты — в map её не будет
   * (вызывающий применит fallback).
   */
  async function ensureRatesForDates(dates) {
    const uniq = [...new Set((Array.isArray(dates) ? dates : []).filter(Boolean))]
    const result = {}
    const missing = []
    for (const ymd of uniq) {
      const cached = getCachedRate(ymd)
      if (cached != null) result[ymd] = cached
      else missing.push(ymd)
    }

    // Тянем недостающие с ограниченной конкуррентностью.
    let idx = 0
    const now = Math.floor(Date.now() / 1000)
    async function worker() {
      while (idx < missing.length) {
        const ymd = missing[idx++]
        const rate = await fetchRateFromCbr(ymd)
        if (rate != null) {
          try {
            upsertStmt.run(ymd, rate, now)
          } catch (_) {}
          result[ymd] = rate
        }
      }
    }
    const workers = Array.from(
      { length: Math.min(FETCH_CONCURRENCY, Math.max(1, missing.length)) },
      () => worker()
    )
    if (missing.length > 0) await Promise.all(workers)
    return result
  }

  return {
    getCachedRate,
    getLatestCachedRate,
    fetchRateFromCbr,
    ensureRatesForDates,
    ymdFromUnix,
  }
}

module.exports = { setupUsdRateService, ymdFromUnix }
