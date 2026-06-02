'use strict'
require('dotenv').config()
const Database = require('better-sqlite3')
const { decryptToken } = require('./src/infra/crypto/tokenCrypto')
const { createRequestDealById } = require('./src/functions/playerokRequestDealById')

const DEAL_PERSISTED_HASH =
  '5652037a966d8da6d41180b0be8226051fe0ed1357d460c6ae348c3138a0fba3'

;(async () => {
  const db = new Database('data/product-settings.db', { readonly: true })
  const rows = db.prepare('SELECT token, token_enc FROM tokens').all()
  let token = ''
  for (const r of rows) {
    if (r.token_enc) { try { token = decryptToken(r.token_enc); if (token) break } catch (_) {} }
    else if (r.token) { token = String(r.token); break }
  }
  if (!token) { console.log('NO TOKEN'); return }
  const requestDealById = createRequestDealById({ DEAL_PERSISTED_HASH })

  const deals = db.prepare('SELECT deal_id, buyer_name FROM chat_deals ORDER BY updated_at DESC LIMIT 40').all()
  let found = 0
  for (const d of deals) {
    let deal
    try { deal = await requestDealById(token, null, d.deal_id) } catch (e) { continue }
    if (!deal) continue
    if (deal.testimonial != null) {
      found += 1
      console.log('=== DEAL', d.deal_id, 'buyer', d.buyer_name, 'status', deal.status, '===')
      console.log(JSON.stringify(deal.testimonial, null, 2))
      if (found >= 3) break
    } else {
      console.log('- no testimonial:', d.deal_id, 'status', deal.status)
    }
  }
  console.log('FOUND testimonials:', found)
})().catch((e) => console.error('ERR', e && e.message ? e.message : e))
