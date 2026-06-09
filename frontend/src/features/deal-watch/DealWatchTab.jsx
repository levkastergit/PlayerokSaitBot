import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchRuntimeJobDetails } from '../../services/dockerApi'

const POLL_MS = 2500
const JOB_ID = 'deal-status-watch'
// Сколько карточек показываем на одной странице внутри группы статуса.
const DEAL_PAGE_SIZE = 12
// Порядок и оформление групп по статусу сделки.
const STATUS_ORDER = [
  { key: 'PAID', cls: 'run' },
  { key: 'SENT', cls: 'idle' },
]

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—'
  const v = Math.max(0, Number(ms))
  if (v < 1000) return `${Math.round(v)} мс`
  const s = v / 1000
  if (s < 60) return `${Math.round(s)} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин ${Math.round(s % 60)} с`
  const h = Math.floor(m / 60)
  return `${h} ч ${m % 60} мин`
}

function formatClockFromSec(tsSec) {
  if (!tsSec || !Number.isFinite(Number(tsSec))) return null
  try {
    return new Date(Number(tsSec) * 1000).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return null
  }
}

function formatPrice(value) {
  const v = Number(value) || 0
  if (v <= 0) return null
  return `${v.toLocaleString('ru-RU')} ₽`
}

const DEAL_STATUS = {
  PAID: { label: 'Оплачено — ожидает отправки товара', cls: 'run' },
  SENT: { label: 'Отправлено — ожидает подтверждения покупателем', cls: 'idle' },
}

const FLOW_KIND = {
  supercell: 'Supercell',
  gpt: 'GPT',
  clode: 'Claude',
  topup: 'Пополнение',
}

const FLOW_STAGE = {
  await_link: 'ожидает ссылку',
  await_access: 'ожидает доступ',
  await_stock: 'ожидает наличие',
  ordering: 'оформляет заказ',
  await_email: 'ожидает почту',
  await_input: 'ожидает данные',
  done: 'готово',
}

function flowWaitingText(flow) {
  if (!flow) return null
  if (flow.stage && FLOW_STAGE[flow.stage]) return FLOW_STAGE[flow.stage]
  if (flow.stage) return flow.stage
  if (flow.kind === 'supercell') return 'ожидает почту Supercell'
  return 'в работе'
}

// Что именно ждёт/должно отправиться по сделке.
function deliveryText(deal, flow) {
  if (flow) {
    const kind = FLOW_KIND[flow.kind] || flow.kind
    const what = flowWaitingText(flow)
    return `${kind}: ${what}`
  }
  if (deal.status === 'PAID') return 'Ожидает отправки товара продавцом'
  if (deal.status === 'SENT') return 'Ожидает подтверждения покупателем'
  return '—'
}

function DealCard({ deal, flow, nowSec, onOpenChat }) {
  const meta = DEAL_STATUS[deal.status] || { label: deal.status || '—', cls: 'muted' }
  const price = formatPrice(deal.price)
  const sold = deal.soldAt ? formatClockFromSec(deal.soldAt) : null
  const soldAgo = deal.soldAt ? formatDuration((nowSec - deal.soldAt) * 1000) : null
  // Запрос сделок (страница продаж) часто не возвращает chatId — тогда берём чат из
  // сопоставленного флоу автовыдачи. Если чата всё равно нет, просто не показываем его.
  const chatId = deal.chatId || (flow && flow.chatId) || null
  const chat = chatId ? String(chatId).slice(0, 10) : null
  const id = String(deal.dealId || '').slice(0, 10)

  return (
    <article className={`card dw-card dw-card--${meta.cls}`}>
      <div className="dw-card__head">
        <h2 className="dw-card__title" title={deal.title || id}>
          {deal.title || `Сделка ${id}`}
        </h2>
        {price ? <span className="dw-card__price">{price}</span> : null}
      </div>

      <div className="dw-card__badges">
        <span className={`dw-badge dw-badge--${meta.cls}`}>{meta.label}</span>
        {deal.category ? <span className="dw-badge dw-badge--cat">{deal.category}</span> : null}
      </div>

      <dl className="dw-rows">
        {deal.buyerName ? (
          <div>
            <dt>Покупатель</dt>
            <dd>{deal.buyerName}</dd>
          </div>
        ) : null}
        <div className="dw-rows__delivery">
          <dt>Что отправляется</dt>
          <dd>
            {deliveryText(deal, flow)}
            {flow && flow.email ? <span className="dw-rows__email"> · {flow.email}</span> : null}
            {flow && flow.ageSec != null ? (
              <span className="dw-rows__age"> · в ожидании {formatDuration(flow.ageSec * 1000)}</span>
            ) : null}
          </dd>
        </div>
        {sold ? (
          <div>
            <dt>Куплено</dt>
            <dd>
              {sold}
              {soldAgo ? <span className="dw-rows__age"> ({soldAgo} назад)</span> : null}
            </dd>
          </div>
        ) : null}
        <div className="dw-rows__ids">
          <dt>Идентификаторы</dt>
          <dd>Сделка #{id}{chat ? ` · чат #${chat}` : ''}</dd>
        </div>
      </dl>

      {chatId ? (
        <div className="dw-card__actions">
          <button type="button" className="dw-chat-btn" onClick={() => onOpenChat(chatId)}>
            Перейти в чат <span aria-hidden="true">→</span>
          </button>
        </div>
      ) : null}
    </article>
  )
}

function FlowCard({ flow, onOpenChat }) {
  const kind = FLOW_KIND[flow.kind] || flow.kind
  return (
    <article className="card dw-card dw-card--flow">
      <div className="dw-card__head">
        <h2 className="dw-card__title">{kind} — автовыдача</h2>
      </div>
      <div className="dw-card__badges">
        <span className="dw-badge dw-badge--run">{flowWaitingText(flow)}</span>
      </div>
      <dl className="dw-rows">
        <div className="dw-rows__delivery">
          <dt>Чат</dt>
          <dd>{flow.chatId ? `чат ${String(flow.chatId).slice(0, 10)}` : '—'}</dd>
        </div>
        {flow.email ? (
          <div>
            <dt>Почта</dt>
            <dd>{flow.email}</dd>
          </div>
        ) : null}
        {flow.ageSec != null ? (
          <div>
            <dt>В ожидании</dt>
            <dd>{formatDuration(flow.ageSec * 1000)}</dd>
          </div>
        ) : null}
      </dl>

      {flow.chatId ? (
        <div className="dw-card__actions">
          <button type="button" className="dw-chat-btn" onClick={() => onOpenChat(flow.chatId)}>
            Перейти в чат <span aria-hidden="true">→</span>
          </button>
        </div>
      ) : null}
    </article>
  )
}

// Пагинатор внутри группы статуса.
function Pager({ page, pageCount, onPage }) {
  if (pageCount <= 1) return null
  return (
    <div className="dw-pager">
      <button
        type="button"
        className="dw-pager__btn"
        disabled={page <= 0}
        onClick={() => onPage(page - 1)}
        aria-label="Предыдущая страница"
      >
        ←
      </button>
      <span className="dw-pager__info">{page + 1} / {pageCount}</span>
      <button
        type="button"
        className="dw-pager__btn"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
        aria-label="Следующая страница"
      >
        →
      </button>
    </div>
  )
}

// Контент наблюдателя сделок без внешней обёртки — встраивается во внутреннюю
// вкладку раздела «Список выполнения».
export function DealWatchPanel() {
  const navigate = useNavigate()
  const [entry, setEntry] = useState(null)
  const [loaded, setLoaded] = useState(false)
  // Текущая страница пагинации по каждой группе (ключ группы -> номер страницы).
  const [pageByGroup, setPageByGroup] = useState({})

  useEffect(() => {
    let cancelled = false
    let timer = null
    const tick = async () => {
      const r = await fetchRuntimeJobDetails(JOB_ID)
      if (cancelled) return
      setLoaded(true)
      setEntry(r)
      timer = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const details = entry?.details || null
  const deals = Array.isArray(details?.deals) ? details.deals : []
  const flows = Array.isArray(details?.flows) ? details.flows : []

  const serverNow = entry?.serverNow || Date.now()
  const nowSec = Math.floor(serverNow / 1000)
  const detailsAt = entry?.detailsAt || null
  // detailsAt у сделок в секундах (updatedAt). serverNow в мс.
  const detailsAtMs = detailsAt && detailsAt < 1e12 ? detailsAt * 1000 : detailsAt
  const staleSec = detailsAtMs ? Math.max(0, Math.round((serverNow - detailsAtMs) / 1000)) : null
  const stale = staleSec != null && staleSec > 20

  // Сопоставляем флоу автовыдачи со сделками (по dealId, иначе по chatId).
  const flowByDeal = new Map()
  const flowByChat = new Map()
  for (const f of flows) {
    if (f.dealId) flowByDeal.set(String(f.dealId), f)
    if (f.chatId) flowByChat.set(String(f.chatId), f)
  }
  const usedFlows = new Set()
  const cards = deals.map((d) => {
    const flow =
      (d.dealId && flowByDeal.get(String(d.dealId))) ||
      (d.chatId && flowByChat.get(String(d.chatId))) ||
      null
    if (flow) usedFlows.add(flow)
    return { deal: d, flow }
  })
  const orphanFlows = flows.filter((f) => !usedFlows.has(f))

  // Честные счётчики: берём с бэкенда (по всем сделкам), а если их нет —
  // считаем по обрезанному снимку (обратная совместимость).
  const dealsTotal = Number.isFinite(Number(details?.dealsTotal))
    ? Number(details.dealsTotal)
    : deals.length
  const flowsTotal = Number.isFinite(Number(details?.flowsTotal))
    ? Number(details.flowsTotal)
    : flows.length
  const byStatus =
    details?.dealsByStatus && typeof details.dealsByStatus === 'object'
      ? details.dealsByStatus
      : null
  const paidCount = byStatus ? Number(byStatus.PAID || 0) : deals.filter((d) => d.status === 'PAID').length
  const sentCount = byStatus ? Number(byStatus.SENT || 0) : deals.filter((d) => d.status === 'SENT').length
  const dealsCapped = Boolean(details?.dealsCapped)

  // Группируем карточки по статусу сделки: PAID → SENT → остальные.
  const groups = new Map()
  for (const c of cards) {
    const st = String(c.deal.status || 'OTHER').toUpperCase()
    if (!groups.has(st)) groups.set(st, [])
    groups.get(st).push(c)
  }
  const orderedKeys = [
    ...STATUS_ORDER.map((s) => s.key).filter((k) => groups.has(k)),
    ...[...groups.keys()].filter((k) => !STATUS_ORDER.some((s) => s.key === k)),
  ]

  const openChat = (chatId) => {
    if (!chatId) return
    navigate('/chat/' + encodeURIComponent(String(chatId)))
  }
  const setPage = (key, p) => setPageByGroup((prev) => ({ ...prev, [key]: p }))

  // Возвращает срез карточек текущей страницы группы + метаданные пагинации.
  const paginate = (key, items) => {
    const pageCount = Math.max(1, Math.ceil(items.length / DEAL_PAGE_SIZE))
    const page = Math.min(Number(pageByGroup[key]) || 0, pageCount - 1)
    const slice = items.slice(page * DEAL_PAGE_SIZE, (page + 1) * DEAL_PAGE_SIZE)
    return { page, pageCount, slice }
  }

  const summaryMain = `Сделок в работе: ${dealsTotal} (оплачено: ${paidCount}, отправлено: ${sentCount}) • ожидают выдачи: ${flowsTotal}`
  const summary = stale
    ? `${summaryMain} • ⚠ данные не обновлялись ${staleSec} с (наблюдатель на паузе?)`
    : summaryMain

  return (
    <>
      <p className="tab-page-description">{summary}</p>
      {dealsCapped ? (
        <p className="dw-cap-note">
          Показаны первые {deals.length} из {dealsTotal} сделок — счётчики выше учитывают все.
        </p>
      ) : null}

      {!loaded ? (
        <p className="exec-empty">Загрузка…</p>
      ) : cards.length === 0 && orphanFlows.length === 0 ? (
        <p className="exec-empty">Сейчас нет активных сделок и автовыдач.</p>
      ) : (
        <div className="dw-sections">
          {orderedKeys.map((key) => {
            const items = groups.get(key) || []
            const meta = DEAL_STATUS[key] || { label: key, cls: 'muted' }
            const cls = STATUS_ORDER.find((s) => s.key === key)?.cls || meta.cls
            const { page, pageCount, slice } = paginate(key, items)
            return (
              <section className="dw-section" key={key}>
                <header className="dw-section__head">
                  <span className={`dw-section__dot dw-section__dot--${cls}`} aria-hidden="true" />
                  <h3 className="dw-section__title">{meta.label}</h3>
                  <span className="dw-section__count">{items.length}</span>
                </header>
                <div className="dw-grid">
                  {slice.map(({ deal, flow }) => (
                    <DealCard key={deal.dealId} deal={deal} flow={flow} nowSec={nowSec} onOpenChat={openChat} />
                  ))}
                </div>
                <Pager page={page} pageCount={pageCount} onPage={(p) => setPage(key, p)} />
              </section>
            )
          })}

          {orphanFlows.length > 0
            ? (() => {
                const key = '__flows__'
                const { page, pageCount, slice } = paginate(key, orphanFlows)
                return (
                  <section className="dw-section" key={key}>
                    <header className="dw-section__head">
                      <span className="dw-section__dot dw-section__dot--run" aria-hidden="true" />
                      <h3 className="dw-section__title">Автовыдачи без привязки к сделке</h3>
                      <span className="dw-section__count">{orphanFlows.length}</span>
                    </header>
                    <div className="dw-grid">
                      {slice.map((f, i) => (
                        <FlowCard key={`flow-${f.kind}-${f.chatId}-${i}`} flow={f} onOpenChat={openChat} />
                      ))}
                    </div>
                    <Pager page={page} pageCount={pageCount} onPage={(p) => setPage(key, p)} />
                  </section>
                )
              })()
            : null}
        </div>
      )}
    </>
  )
}
