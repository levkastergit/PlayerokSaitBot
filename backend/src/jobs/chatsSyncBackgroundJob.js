const { recordChatSyncStepLog } = require('../debug/chatSyncStepLog')
const { registerJob, markTickStart, markTickEnd } = require('../infra/jobsRegistry')
const { runWithPlayerokUser } = require('../infra/playerokRequestContext')

const JOB_ID = 'chats-sync'

// Длительность бэкофа после ошибки (мс) с джиттером, чтобы повторы нескольких
// пользователей/вкладок не били Playerok синхронно сразу после снятия блока.
function backoffMs(message) {
  const isRateLimited =
    /\b429\b/.test(message) || /too many/i.test(message) || /rate limit/i.test(message)
  return isRateLimited
    ? 4000 + Math.floor(Math.random() * 1500)
    : 1500 + Math.floor(Math.random() * 1000)
}

function setupChatsSyncBackgroundJob({
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  chatDbSyncService,
  chatDbRepo = null,
  isAllActionsStopped = () => false,
  intervalMs = 500,
}) {
  // Интервал тика конфигурируется через CHATS_SYNC_INTERVAL_MS (см. server.js), но
  // жёстко ограничен [250, 5000] мс: 0 заспамил бы Playerok, слишком большое — чаты «залипнут».
  const tickMs = Math.min(5000, Math.max(250, Number(intervalMs) || 500))

  registerJob({
    id: JOB_ID,
    label: 'Синхронизация чатов',
    description: 'Опрашивает новые сообщения и сохраняет их в БД (быстрый цикл)',
    intervalMs: tickMs,
  })

  // Сколько изменившихся чатов догружаем за один тик: бурст «прилетело сразу несколько»
  // больше не растягивается по одному чату на тик. Реальные HTTP всё равно разносит гейт 280мс.
  const DRAIN_PER_TICK = 2

  const listInFlightByUser = new Set()
  const messagesInFlightByUser = new Set()
  const messageQueueByUser = new Map()
  const viewerUsernameByUser = new Map()
  // РАЗДЕЛЬНЫЙ бэкофф: 429 на дешёвом опросе списка и 429 на тяжёлой догрузке сообщений
  // больше НЕ блокируют друг друга. Детект новых сообщений продолжает работать, даже
  // если догрузка одного чата словила 429 — и наоборот.
  const listBackoffUntilByUser = new Map()
  const msgBackoffUntilByUser = new Map()

  // Цикл быстрый (500 мс) и асинхронный: без общего флага два прохода могли бы
  // наложиться и испортить учёт тиков (totalRuns/lastTickStartAt/inFlight) в реестре.
  let tickInFlight = false

  function enqueueChanged(userId, items) {
    if (!Array.isArray(items) || items.length === 0) return
    const q = messageQueueByUser.get(userId) || []
    const byId = new Map(q.map((item) => [String(item.thread.id), item]))
    for (const item of items) {
      byId.set(String(item.thread.id), item)
    }
    messageQueueByUser.set(userId, [...byId.values()])
  }

  setInterval(async () => {
    if (isAllActionsStopped()) return
    const rows = getAllStoredTokens.all()
    if (!Array.isArray(rows) || rows.length === 0) return
    if (tickInFlight) return
    tickInFlight = true
    const now = Date.now()
    markTickStart(JOB_ID)
    let tickError = null
    try {
      for (const row of rows) {
        const userId = Number(row?.user_id)
        if (!Number.isFinite(userId) || userId <= 0) continue

        // Все исходящие запросы Playerok этого пользователя выполняем в его контексте,
        // иначе resolveOutboundLocalAddress не увидит userId и привязки/ротация
        // исходящего IP не применятся (запросы уйдут с env-фолбэка PLAYEROK_OUTBOUND_IP,
        // без чередования IP). Внутри continue заменён на return — он завершает обработку
        // текущего пользователя, цикл продолжается со следующим (тело await-ится).
        await runWithPlayerokUser(userId, async () => {
          const stored = loadStoredTokenPlain(userId)
          if (!stored || !stored.token) return

          const ua = getUserAgent()

          // --- Опрос списка чатов (дешёвый, детект новых сообщений) ---
          const listBlockedUntil = Number(listBackoffUntilByUser.get(userId) || 0)
          if (listBlockedUntil <= now && !listInFlightByUser.has(userId)) {
            listInFlightByUser.add(userId)
            try {
              const listResult = await chatDbSyncService.syncUserChatsListPoll({
                userId,
                token: stored.token,
                userAgent: ua,
              })
              if (listResult.viewerUsername) {
                viewerUsernameByUser.set(userId, listResult.viewerUsername)
              }
              enqueueChanged(userId, listResult.changedChats)
              listBackoffUntilByUser.delete(userId)
            } catch (err) {
              const message = err && err.message ? String(err.message) : String(err)
              recordChatSyncStepLog({
                ok: false,
                userId,
                phase: 'error',
                source: 'userChats',
                error: message,
              })
              listBackoffUntilByUser.set(userId, Date.now() + backoffMs(message))
            } finally {
              listInFlightByUser.delete(userId)
            }
          }

          // --- Догрузка изменившихся чатов (тяжёлая, до DRAIN_PER_TICK за тик) ---
          const msgBlockedUntil = Number(msgBackoffUntilByUser.get(userId) || 0)
          if (msgBlockedUntil > now) return
          if (messagesInFlightByUser.has(userId)) return
          if (((messageQueueByUser.get(userId) || []).length) === 0) return

          messagesInFlightByUser.add(userId)
          try {
            let drained = 0
            while (drained < DRAIN_PER_TICK) {
              // Очередь перечитываем каждую итерацию: enqueueChanged мог заменить массив.
              const queue = messageQueueByUser.get(userId) || []
              if (queue.length === 0) break
              const item = queue.shift()
              messageQueueByUser.set(userId, queue)
              drained += 1
              await chatDbSyncService.syncOneChangedChat({
                userId,
                token: stored.token,
                userAgent: ua,
                item,
                viewerUsername: viewerUsernameByUser.get(userId) || null,
                runAutomation: true,
                queueLeft: queue.length,
              })
            }
            msgBackoffUntilByUser.delete(userId)
          } catch (err) {
            const message = err && err.message ? String(err.message) : String(err)
            msgBackoffUntilByUser.set(userId, Date.now() + backoffMs(message))
          } finally {
            messagesInFlightByUser.delete(userId)
          }
        })
      }
    } catch (err) {
      tickError = err
    } finally {
      tickInFlight = false
      markTickEnd(JOB_ID, tickError)
    }
  }, tickMs)
}

module.exports = { setupChatsSyncBackgroundJob }
