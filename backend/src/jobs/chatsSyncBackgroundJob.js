const { recordChatSyncStepLog } = require('../debug/chatSyncStepLog')
const { registerJob, markTickStart, markTickEnd } = require('../infra/jobsRegistry')
const { runWithPlayerokUser } = require('../infra/playerokRequestContext')
const { isOutboundCircuitOpen } = require('../infra/playerokOutboundIp')

const JOB_ID = 'chats-sync'

function setupChatsSyncBackgroundJob({
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  chatDbSyncService,
  chatDbRepo = null,
  isAllActionsStopped = () => false,
  intervalMs = 500,
}) {
  registerJob({
    id: JOB_ID,
    label: 'Синхронизация чатов',
    description: 'Опрашивает новые сообщения и сохраняет их в БД (быстрый цикл)',
    intervalMs,
  })

  const listInFlightByUser = new Set()
  const messagesInFlightByUser = new Set()
  const messageQueueByUser = new Map()
  const viewerUsernameByUser = new Map()
  const backoffUntilByUser = new Map()

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
    if (isOutboundCircuitOpen()) return
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
          const blockedUntil = Number(backoffUntilByUser.get(userId) || 0)
          if (blockedUntil > now) return

          const stored = loadStoredTokenPlain(userId)
          if (!stored || !stored.token) return

          const ua = getUserAgent()

          if (!listInFlightByUser.has(userId)) {
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
              backoffUntilByUser.delete(userId)
            } catch (err) {
              const message = err && err.message ? String(err.message) : String(err)
              recordChatSyncStepLog({
                ok: false,
                userId,
                phase: 'error',
                source: 'userChats',
                error: message,
              })
              const isRateLimited =
                /\b429\b/.test(message) ||
                /too many/i.test(message) ||
                /rate limit/i.test(message)
              backoffUntilByUser.set(userId, Date.now() + (isRateLimited ? 4000 : 1500))
            } finally {
              listInFlightByUser.delete(userId)
            }
          }

          if (messagesInFlightByUser.has(userId)) return
          const queue = messageQueueByUser.get(userId) || []
          if (queue.length === 0) return

          const item = queue.shift()
          messageQueueByUser.set(userId, queue)
          messagesInFlightByUser.add(userId)

          try {
            await chatDbSyncService.syncOneChangedChat({
              userId,
              token: stored.token,
              userAgent: ua,
              item,
              viewerUsername: viewerUsernameByUser.get(userId) || null,
              runAutomation: true,
              queueLeft: queue.length,
            })
            backoffUntilByUser.delete(userId)
          } catch (err) {
            const message = err && err.message ? String(err.message) : String(err)
            const isRateLimited =
              /\b429\b/.test(message) ||
              /too many/i.test(message) ||
              /rate limit/i.test(message)
            backoffUntilByUser.set(userId, Date.now() + (isRateLimited ? 4000 : 1500))
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
  }, intervalMs)
}

module.exports = { setupChatsSyncBackgroundJob }
