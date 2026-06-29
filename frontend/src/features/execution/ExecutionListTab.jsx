import { useEffect, useRef, useState } from 'react'
import { fetchRuntimeJobs, fetchRuntimeJobDetails } from '../../services/dockerApi'
import { DealWatchPanel } from '../deal-watch/DealWatchTab.jsx'

// Как часто опрашиваем сервер за свежим снимком задач.
const POLL_MS = 2500
// Детали (очередь/сделки) развёрнутой плитки опрашиваем чуть чаще.
const DETAILS_POLL_MS = 2000
// Циклы короче этого порога рисуем непрерывной «бегущей» полосой вместо
// заполнения-сброса — иначе на интервале 0.5 с полоса мигает слишком часто.
const INDETERMINATE_MAX_MS = 1500

function formatInterval(ms) {
  const v = Number(ms) || 0
  if (v <= 0) return '—'
  if (v < 1000) return `${v} мс`
  const s = v / 1000
  if (s < 60) return Number.isInteger(s) ? `${s} с` : `${s.toFixed(1)} с`
  const m = s / 60
  if (m < 60) return Number.isInteger(m) ? `${m} мин` : `${m.toFixed(1)} мин`
  return `${(m / 60).toFixed(1)} ч`
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—'
  const v = Math.max(0, Number(ms))
  if (v < 1000) return `${Math.round(v)} мс`
  const s = v / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} с`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  return `${m} мин ${rest} с`
}

function formatNumber(n) {
  return (Number(n) || 0).toLocaleString('ru-RU')
}

// Относительное время до unix-метки (сек): «через ~5 мин» / «сейчас» / «—».
function formatRelFromSec(tsSec) {
  if (!tsSec || !Number.isFinite(Number(tsSec))) return null
  const deltaMs = Number(tsSec) * 1000 - Date.now()
  if (deltaMs <= 1000) return 'сейчас'
  return `через ${formatDuration(deltaMs)}`
}

function formatClockFromSec(tsSec) {
  if (!tsSec || !Number.isFinite(Number(tsSec))) return null
  try {
    return new Date(Number(tsSec) * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return null
  }
}

const BUMP_STATUS = {
  bumped: { label: 'Поднимается сейчас', cls: 'run' },
  queued: { label: 'В очереди', cls: 'idle' },
  cooldown: { label: 'Пауза (антифлуд)', cls: 'idle' },
  window_done: { label: 'Окно завершено', cls: 'muted' },
  out_of_window: { label: 'Вне расписания', cls: 'muted' },
  error: { label: 'Ошибка', cls: 'err' },
}

// Статусы подзадач автовыставления (одна подзадача одного прохода).
const STEP_STATUS = {
  run: { label: 'Выполняется', cls: 'run' },
  ok: { label: 'Готово', cls: 'ok' },
  idle: { label: 'Нет работы', cls: 'idle' },
  skip: { label: 'Пропущено', cls: 'muted' },
  err: { label: 'Ошибка', cls: 'err' },
}

// Подзадачи одного прохода автовыставления как пронумерованный конвейер:
// шаги идут строго по порядку выполнения (чаты → перевыставление → оплаченные
// чаты → автосообщения → флоу), соединены вертикальной линией. Пройденные шаги
// заливаются акцентом, активный (если поймали проход на лету) подсвечен и
// анимирован, ошибочный — красным.
function AutolistPipeline({ steps }) {
  const list = Array.isArray(steps) ? steps : []
  if (list.length === 0) return null
  return (
    <ol className="exec-pipe">
      {list.map((s, i) => {
        const meta = STEP_STATUS[s.status] || { label: s.status, cls: 'muted' }
        const isLast = i === list.length - 1
        const running = s.status === 'run'
        return (
          <li
            key={s.id || i}
            className={`exec-pipe__node exec-pipe__node--${meta.cls}${running ? ' exec-pipe__node--active' : ''}`}
          >
            <div className="exec-pipe__rail">
              <span className="exec-pipe__num" aria-hidden="true">{i + 1}</span>
              {!isLast ? <span className="exec-pipe__line" /> : null}
            </div>
            <div className="exec-pipe__body">
              <div className="exec-pipe__head">
                <span className="exec-pipe__label" title={s.label}>{s.label}</span>
                <span className={`exec-chip exec-chip--${meta.cls}`}>{meta.label}</span>
              </div>
              {running ? (
                <div className="exec-pipe__bar">
                  <div className="exec-pipe__bar-fill" />
                </div>
              ) : null}
              <div className="exec-pipe__meta">
                {Number(s.count) > 0 ? (
                  <span className="exec-pipe__count">{formatNumber(s.count)} обработано</span>
                ) : null}
                <span className="exec-pipe__dur">{formatDuration(s.ms)}</span>
                {s.note ? <span className="exec-pipe__note" title={s.note}>· {s.note}</span> : null}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ── Детали конкретных задач ────────────────────────────────────────────────

function BumpDetails({ details }) {
  const items = Array.isArray(details?.items) ? details.items : []
  if (items.length === 0) {
    return <p className="exec-details__empty">Нет лотов с автоподнятием в активных окнах расписания.</p>
  }
  return (
    <ul className="exec-details__list">
      {items.map((it, i) => {
        const meta = BUMP_STATUS[it.status] || { label: it.status, cls: 'muted' }
        const rel = it.nextBumpTs ? formatRelFromSec(it.nextBumpTs) : null
        const clock = it.nextBumpTs ? formatClockFromSec(it.nextBumpTs) : null
        return (
          <li key={`${it.title}-${i}`} className="exec-details__row">
            <span className="exec-details__title" title={it.title}>{it.title}</span>
            <span className={`exec-chip exec-chip--${meta.cls}`}>{meta.label}</span>
            {rel ? (
              <span className="exec-details__when">{rel}{clock ? ` · ${clock}` : ''}</span>
            ) : (
              <span className="exec-details__when" />
            )}
          </li>
        )
      })}
    </ul>
  )
}

function AutolistDetails({ details }) {
  const users = Array.isArray(details?.users) ? details.users : []
  const steps = Array.isArray(details?.steps) ? details.steps : []
  // Конвейер подзадач — отдельный раскрывающийся список (по умолчанию открыт).
  const [stepsOpen, setStepsOpen] = useState(true)
  const runningCount = steps.filter((s) => s && s.status === 'run').length
  return (
    <div>
      <p className="exec-details__note">
        «Интервал» — это частота планирования, а не гарантия запуска каждые N секунд. Один проход обходит все чаты и
        активные выдачи и может длиться дольше интервала (обычно из-за лимитера запросов Playerok и числа чатов/выдач).
        Новый проход стартует только после завершения текущего — наложения нет. Подробные тайминги пишутся в логи (тег
        autolist).
      </p>
      {steps.length > 0 ? (
        <div className="exec-pipe-wrap">
          <button
            type="button"
            className="exec-pipe-toggle"
            onClick={() => setStepsOpen((v) => !v)}
            aria-expanded={stepsOpen}
          >
            <span className="exec-pipe-toggle__title">Подзадачи прохода — конвейер</span>
            <span className="exec-pipe-toggle__count">{steps.length}</span>
            {runningCount > 0 ? (
              <span className="exec-pipe-toggle__live">▶ {runningCount} идёт</span>
            ) : null}
            <span className="exec-pipe-toggle__chevron" aria-hidden="true">{stepsOpen ? '▲' : '▼'}</span>
          </button>
          {stepsOpen ? <AutolistPipeline steps={steps} /> : null}
        </div>
      ) : null}
      <div className="exec-details__metric">
        Последний проход: <b>{formatDuration(details?.totalMs)}</b> · интервал {formatInterval(details?.intervalMs)}
      </div>
      {users.length === 0 ? (
        <p className="exec-details__empty">Нет активных пользователей с токеном.</p>
      ) : (
        <ul className="exec-details__list">
          {users.map((u, i) => (
            <li key={`${u.userId}-${i}`} className="exec-details__row">
              <span className="exec-details__title">Пользователь #{u.userId}</span>
              <span className={`exec-chip exec-chip--${Number(u.ms) > 8000 ? 'err' : 'idle'}`}>{formatDuration(u.ms)}</span>
              <span className="exec-details__when">{u.outcome}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Параллельные под-задачи (флоу выдачи) — каждая отдельной мини-карточкой в сетке.
function ParallelTasks({ steps }) {
  const list = Array.isArray(steps) ? steps : []
  if (list.length === 0) return null
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: '0.6rem',
        marginTop: '0.5rem',
      }}
    >
      {list.map((s, i) => {
        const meta = STEP_STATUS[s.status] || { label: s.status, cls: 'muted' }
        const running = s.status === 'run'
        return (
          <div
            key={s.id || i}
            className={`card exec-tile exec-tile--${running ? 'run' : 'idle'}`}
            style={{ padding: '0.7rem 0.8rem', gap: '0.4rem', minHeight: 0 }}
          >
            <div className="exec-tile__top" style={{ gap: '0.4rem' }}>
              <span className="exec-tile__dot" aria-hidden="true" />
              <h2 className="exec-tile__title" style={{ fontSize: '0.92rem' }} title={s.label}>{s.label}</h2>
              <span className={`exec-chip exec-chip--${meta.cls}`}>{meta.label}</span>
            </div>
            <div className="exec-pipe__meta">
              {Number(s.count) > 0 ? (
                <span className="exec-pipe__count">{formatNumber(s.count)} активн.</span>
              ) : (
                <span className="exec-pipe__note">нет работы</span>
              )}
              <span className="exec-pipe__dur">{formatDuration(s.ms)}</span>
            </div>
            {s.note ? <span className="exec-pipe__note" title={s.note}>· {s.note}</span> : null}
          </div>
        )
      })}
    </div>
  )
}

// Детали задачи на основе под-шагов: последовательные — конвейером (одна цепочка),
// параллельные (parallel:true) — отдельными мини-карточками.
function StepsDetails({ details }) {
  const users = Array.isArray(details?.users) ? details.users : []
  const allSteps = Array.isArray(details?.steps) ? details.steps : []
  const seqSteps = allSteps.filter((s) => s && !s.parallel)
  const parSteps = allSteps.filter((s) => s && s.parallel)
  const [seqOpen, setSeqOpen] = useState(true)
  const seqRunning = seqSteps.filter((s) => s.status === 'run').length
  return (
    <div>
      {seqSteps.length > 0 ? (
        <div className="exec-pipe-wrap">
          <button
            type="button"
            className="exec-pipe-toggle"
            onClick={() => setSeqOpen((v) => !v)}
            aria-expanded={seqOpen}
          >
            <span className="exec-pipe-toggle__title">Под-шаги (последовательно)</span>
            <span className="exec-pipe-toggle__count">{seqSteps.length}</span>
            {seqRunning > 0 ? <span className="exec-pipe-toggle__live">▶ {seqRunning} идёт</span> : null}
            <span className="exec-pipe-toggle__chevron" aria-hidden="true">{seqOpen ? '▲' : '▼'}</span>
          </button>
          {seqOpen ? <AutolistPipeline steps={seqSteps} /> : null}
        </div>
      ) : null}
      {parSteps.length > 0 ? (
        <div className="exec-pipe-wrap">
          <div className="exec-pipe-toggle" style={{ cursor: 'default' }}>
            <span className="exec-pipe-toggle__title">Параллельно — каждая задача отдельно</span>
            <span className="exec-pipe-toggle__count">{parSteps.length}</span>
          </div>
          <ParallelTasks steps={parSteps} />
        </div>
      ) : null}
      <div className="exec-details__metric">
        Последний проход: <b>{formatDuration(details?.totalMs)}</b> · интервал {formatInterval(details?.intervalMs)}
      </div>
      {users.length === 0 ? (
        <p className="exec-details__empty">Нет активных пользователей с токеном.</p>
      ) : (
        <ul className="exec-details__list">
          {users.map((u, i) => (
            <li key={`${u.userId}-${i}`} className="exec-details__row">
              <span className="exec-details__title">Пользователь #{u.userId}</span>
              <span className={`exec-chip exec-chip--${Number(u.ms) > 8000 ? 'err' : 'idle'}`}>{formatDuration(u.ms)}</span>
              <span className="exec-details__when">{u.outcome}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const STEPS_JOB_IDS = new Set(['autolist', 'relist', 'paid-delivery', 'automessages', 'delivery-flows'])

function JobDetails({ jobId, entry }) {
  if (!entry) return <p className="exec-details__empty">Загрузка деталей…</p>
  if (!entry.ok || !entry.details) {
    return <p className="exec-details__empty">Нет детальных данных (задача ещё не выполняла проход).</p>
  }
  if (jobId === 'autobump') return <BumpDetails details={entry.details} />
  if (STEPS_JOB_IDS.has(jobId)) return <StepsDetails details={entry.details} />
  return <p className="exec-details__empty">—</p>
}

// ── Плитка задачи ──────────────────────────────────────────────────────────

function ExecTile({ job, stoppedAll, barRefs, nextRefs, expanded, onToggle, detailsEntry }) {
  const interval = Number(job.intervalMs) || 0
  const indeterminate = interval > 0 && interval < INDETERMINATE_MAX_MS
  const status = stoppedAll ? 'stopped' : job.inFlight ? 'run' : 'idle'
  const statusText = stoppedAll ? 'Остановлено' : job.inFlight ? 'Выполняется' : 'Ожидание'
  const hasErrors = Number(job.totalErrors) > 0
  // Наблюдатель сделок вынесен в отдельную вкладку «Наблюдатель сделок» —
  // в списке выполнения оставляем его как обычную плитку статуса (без раскрытия).
  const canExpand = Boolean(job.hasDetails) && job.id !== 'deal-status-watch'

  const setBarRef = (el) => {
    if (el) barRefs.current.set(job.id, el)
    else barRefs.current.delete(job.id)
  }
  const setNextRef = (el) => {
    if (el) nextRefs.current.set(job.id, el)
    else nextRefs.current.delete(job.id)
  }

  return (
    <article className={`card exec-tile exec-tile--${status}${expanded ? ' exec-tile--expanded' : ''}`}>
      <div className="exec-tile__top">
        <span className="exec-tile__dot" aria-hidden="true" />
        <h2 className="exec-tile__title">{job.label}</h2>
        <span className={`exec-badge exec-badge--${status}`}>{statusText}</span>
      </div>

      {job.description ? <p className="exec-tile__desc">{job.description}</p> : null}

      <div className="exec-tile__bar">
        <div
          className={
            'exec-tile__bar-track' +
            (indeterminate && !stoppedAll ? ' exec-tile__bar-track--loop' : '') +
            (stoppedAll ? ' exec-tile__bar-track--paused' : '')
          }
        >
          <div
            className="exec-tile__bar-fill"
            ref={setBarRef}
            style={indeterminate && !stoppedAll ? undefined : { width: '0%' }}
          />
        </div>
        <div className="exec-tile__bar-meta">
          <span
            className="exec-tile__interval"
            title="Интервал планирования. Если проход длится дольше, новый цикл стартует только после завершения текущего (без наложения)."
          >
            Интервал: {formatInterval(interval)}
          </span>
          {stoppedAll ? (
            <span className="exec-tile__next">на паузе</span>
          ) : indeterminate ? (
            <span className="exec-tile__next">непрерывный цикл</span>
          ) : (
            <span className="exec-tile__next" ref={setNextRef} />
          )}
        </div>
      </div>

      {!stoppedAll && job.inFlight ? (
        <p className="exec-tile__note">
          Идёт текущий проход — новый цикл начнётся только после его завершения (проходы не накладываются).
        </p>
      ) : null}

      <dl className="exec-tile__stats">
        <div>
          <dt>Запусков</dt>
          <dd>{formatNumber(job.totalRuns)}</dd>
        </div>
        <div>
          <dt>Последний проход</dt>
          <dd>{formatDuration(job.lastDurationMs)}</dd>
        </div>
        <div className={hasErrors ? 'exec-tile__stat--err' : undefined}>
          <dt>Ошибок</dt>
          <dd>{formatNumber(job.totalErrors)}</dd>
        </div>
      </dl>

      {hasErrors && job.lastError ? (
        <p className="exec-tile__err" title={job.lastError}>
          ⚠ {job.lastError}
        </p>
      ) : null}

      {canExpand ? (
        <>
          <button
            type="button"
            className="exec-tile__toggle"
            onClick={() => onToggle(job.id)}
            aria-expanded={expanded}
          >
            {expanded ? 'Скрыть детали ▲' : 'Показать детали ▼'}
          </button>
          {expanded ? (
            <div className="exec-details">
              <JobDetails jobId={job.id} entry={detailsEntry} />
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  )
}

export function ExecutionListTab() {
  const [data, setData] = useState({ ok: false, stoppedAll: false, serverNow: Date.now(), jobs: [] })
  const [loaded, setLoaded] = useState(false)
  const [hadError, setHadError] = useState(false)
  const [expanded, setExpanded] = useState(() => new Set())
  const [detailsById, setDetailsById] = useState({})
  // Внутренние вкладки раздела: список задач и наблюдатель сделок.
  const [view, setView] = useState('tasks')

  // Снимок для анимации: серверное время на момент ответа + локальное performance.now(),
  // чтобы считать фазу цикла без зависимости от рассинхрона часов клиент/сервер.
  const syncRef = useRef({ serverNow: 0, perf: 0, stoppedAll: false, jobs: new Map() })
  const barRefs = useRef(new Map())
  const nextRefs = useRef(new Map())

  useEffect(() => {
    let cancelled = false
    let timer = null
    const tick = async () => {
      const result = await fetchRuntimeJobs()
      if (cancelled) return
      setLoaded(true)
      setHadError(!result.ok)
      if (result.ok || result.jobs.length > 0) {
        setData(result)
        const map = new Map()
        for (const j of result.jobs) map.set(j.id, j)
        syncRef.current = {
          serverNow: result.serverNow,
          perf: performance.now(),
          stoppedAll: result.stoppedAll,
          jobs: map,
        }
      }
      timer = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Поллинг деталей только для развёрнутых плиток на вкладке задач.
  useEffect(() => {
    if (view !== 'tasks' || expanded.size === 0) return undefined
    let cancelled = false
    let timer = null
    const poll = async () => {
      const ids = [...expanded]
      const results = await Promise.all(
        ids.map((id) => fetchRuntimeJobDetails(id).then((r) => [id, r]))
      )
      if (cancelled) return
      setDetailsById((prev) => {
        const next = { ...prev }
        for (const [id, r] of results) next[id] = r
        return next
      })
      timer = setTimeout(poll, DETAILS_POLL_MS)
    }
    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [expanded, view])

  useEffect(() => {
    let raf = 0
    const loop = () => {
      const sync = syncRef.current
      const elapsedSinceFetch = performance.now() - sync.perf
      for (const [id, job] of sync.jobs) {
        const barEl = barRefs.current.get(id)
        if (!barEl) continue
        const interval = Number(job.intervalMs) || 0
        const indeterminate = interval > 0 && interval < INDETERMINATE_MAX_MS
        if (sync.stoppedAll || indeterminate || interval <= 0 || job.lastTickStartAt == null) {
          continue
        }
        // Фаза = сколько прошло с РЕАЛЬНОГО старта последнего тика (по серверным
        // меткам, без рассинхрона часов). Полосу НЕ прокручиваем по модулю — иначе
        // во время бэкоффа/долгого прохода рисовались бы фантомные циклы.
        const phase = sync.serverNow - job.lastTickStartAt + elapsedSinceFetch
        const nextEl = nextRefs.current.get(id)
        if (job.inFlight) {
          // Тик ещё выполняется: показываем живую длительность текущего прохода.
          barEl.style.width = phase >= interval ? '100%' : (Math.max(0, phase) / interval * 100).toFixed(2) + '%'
          if (nextEl) nextEl.textContent = `идёт ${formatDuration(Math.max(0, phase))}`
        } else if (phase >= interval) {
          barEl.style.width = '100%'
          if (nextEl) nextEl.textContent = 'ожидание запуска'
        } else {
          const frac = phase <= 0 ? 0 : phase / interval
          barEl.style.width = (frac * 100).toFixed(2) + '%'
          if (nextEl) nextEl.textContent = `следующий запуск через ${formatDuration(interval - phase)}`
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runningNow = data.jobs.filter((j) => j.inFlight).length
  const staleNote = hadError && loaded ? ' • ⚠ данные устарели' : ''
  const summary = data.stoppedAll
    ? 'Все фоновые действия на сервере остановлены — задачи на паузе.'
    : `Фоновых задач на сервере: ${data.jobs.length} • выполняется прямо сейчас: ${runningNow}${staleNote}`

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Список выполнения</h1>
        <div className="exec-subtabs" role="tablist" aria-label="Разделы списка выполнения">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'tasks'}
            className={`exec-subtab${view === 'tasks' ? ' exec-subtab--active' : ''}`}
            onClick={() => setView('tasks')}
          >
            Задачи
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'deals'}
            className={`exec-subtab${view === 'deals' ? ' exec-subtab--active' : ''}`}
            onClick={() => setView('deals')}
          >
            Наблюдатель сделок
          </button>
        </div>
      </div>

      {view === 'deals' ? (
        <DealWatchPanel />
      ) : (
        <>
          <p className="tab-page-description">{summary}</p>
          {!loaded ? (
            <p className="exec-empty">Загрузка…</p>
          ) : data.jobs.length === 0 ? (
            <p className="exec-empty">
              {hadError
                ? 'Не удалось получить список задач с сервера.'
                : 'Сейчас на сервере нет зарегистрированных фоновых задач.'}
            </p>
          ) : (
            <div className="exec-grid">
              {data.jobs.map((job) => (
                <ExecTile
                  key={job.id}
                  job={job}
                  stoppedAll={data.stoppedAll}
                  barRefs={barRefs}
                  nextRefs={nextRefs}
                  expanded={expanded.has(job.id)}
                  onToggle={toggle}
                  detailsEntry={detailsById[job.id]}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
