const { recordChatSyncStepLog } = require('../debug/chatSyncStepLog')



function setupChatsSyncBackgroundJob({

  getAllStoredTokens,

  loadStoredTokenPlain,

  getUserAgent,

  chatDbSyncService,

  chatDbRepo = null,

  isAllActionsStopped = () => false,

  intervalMs = 500,

}) {

  const listInFlightByUser = new Set()

  const messagesInFlightByUser = new Set()

  const messageQueueByUser = new Map()

  const viewerUsernameByUser = new Map()

  const backoffUntilByUser = new Map()



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

    const now = Date.now()



    for (const row of rows) {

      const userId = Number(row?.user_id)

      if (!Number.isFinite(userId) || userId <= 0) continue

      const blockedUntil = Number(backoffUntilByUser.get(userId) || 0)

      if (blockedUntil > now) continue



      const stored = loadStoredTokenPlain(userId)

      if (!stored || !stored.token) continue



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



      if (messagesInFlightByUser.has(userId)) continue

      const queue = messageQueueByUser.get(userId) || []

      if (queue.length === 0) continue



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

    }

  }, intervalMs)

}



module.exports = { setupChatsSyncBackgroundJob }

