async function handleChats({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    getHiddenChats,
    withRetry,
    isPlayerokRateLimitError,
    getViewer,
    requestUserChatsPage,
    fetchActiveItemsFromPlayerok,
    fetchCompletedItemsFromPlayerok,
    fetchDealsFromPlayerok,
    requestDealById,
    requestChatById,
    requestItemById,
    requestChatMessagesPage,
    extractItemImageUrl,
    getChatsSnapshotCache,
    setChatsSnapshotCache,
    isChatsSnapshotFresh,
    scheduleChatsSnapshotRefresh,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const afterCursor = payload.afterCursor || payload.after || null
  const preferCache = payload?.preferCache !== false
  const warmup = payload?.warmup === true

  const limitRaw = payload.limit
  let limit = Number.isFinite(limitRaw) ? Number(limitRaw) : null
  if (!limit || limit <= 0) limit = 24
  if (limit > 50) limit = 50

  if (!token) {
    return { statusCode: 400, data: { error: 'Token is required' } }
  }

  const cacheKey = JSON.stringify({
    limit,
    afterCursor: afterCursor || null,
  })
  if (preferCache && typeof getChatsSnapshotCache === 'function') {
    const cached = getChatsSnapshotCache(currentUserId, cacheKey)
    if (cached && cached.data) {
      const data = cached.data
      const fresh = typeof isChatsSnapshotFresh === 'function'
        ? isChatsSnapshotFresh(currentUserId, cacheKey)
        : false
      if (fresh) {
        return { statusCode: 200, data }
      }
      if (!warmup && typeof scheduleChatsSnapshotRefresh === 'function') {
        scheduleChatsSnapshotRefresh(currentUserId, token, userAgent, { limit, afterCursor: afterCursor || null })
      }
      return { statusCode: 200, data }
    }
  }

  const DEFAULT_CATEGORY = 'Категория не определена'
  const COMMON_CATEGORY_HINTS = [
    'Clash of Clans',
    'Clash Royale',
    'Brawl Stars',
    'Hay Day',
    'Boom Beach',
    'PUBG',
    'PUBG Mobile',
    'Call of Duty',
    'Free Fire',
    'Fortnite',
    'CS:GO',
    'CS2',
    'Counter-Strike',
    'Dota 2',
    'League of Legends',
    'Valorant',
    'Apex Legends',
    'Genshin Impact',
    'Honkai',
    'Star Rail',
    'World of Tanks',
    'World of Warships',
    'War Thunder',
    'Minecraft',
    'Roblox',
    'Among Us',
    'Fall Guys',
    'Mobile Legends',
    'Wild Rift',
    'Arena of Valor',
    'Heroes of the Storm',
    'Overwatch',
    'YouTube',
    'Claude',
    'ChatGPT',
    'ЧатГПТ',
    'Telegram',
    'Discord',
  ]

  const normalizeCategory = (value) => {
    if (typeof value !== 'string') return null
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (!normalized) return null
    if (normalized.toLowerCase() === DEFAULT_CATEGORY.toLowerCase()) return null
    return normalized
  }

  const categoryFromProductKey = (productKey) => {
    if (typeof productKey !== 'string') return null
    const sepIndex = productKey.indexOf('::')
    if (sepIndex <= 0) return null
    return normalizeCategory(productKey.slice(0, sepIndex))
  }

  const categoryFromTextHints = (value) => {
    if (typeof value !== 'string') return null
    const text = value.trim().toLowerCase()
    if (!text) return null
    for (const hint of COMMON_CATEGORY_HINTS) {
      if (text.includes(String(hint).toLowerCase())) {
        return hint
      }
    }
    return null
  }

  const shortCategoryFromText = (value, wordsCount = 2) => {
    if (typeof value !== 'string') return null
    const words = value.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return null
    return normalizeCategory(words.slice(0, wordsCount).join(' '))
  }

  try {
    const tokenHash = token
    const hiddenRows = getHiddenChats.all(currentUserId)
    const hiddenSet = new Set(
      (hiddenRows || [])
        .map((r) => (r && r.chat_id != null ? String(r.chat_id) : null))
        .filter(Boolean)
    )

    const viewer = await withRetry(() => getViewer(token, userAgent), {
      label: 'getViewer(chats)',
      retries: 2,
      shouldRetry: isPlayerokRateLimitError,
    })

    const normalizeComparableUsername = (value) => String(value || '').trim().toLowerCase()
    const viewerUsernameNormalized = normalizeComparableUsername(viewer?.username)

    const isViewerUsername = (value) => {
      const normalized = normalizeComparableUsername(value)
      if (!normalized) return false
      return viewerUsernameNormalized ? normalized === viewerUsernameNormalized : false
    }

    const extractBuyerNameFromMessages = (messages) => {
      const list = Array.isArray(messages) ? messages : []
      for (const message of list) {
        const username = message?.user?.username || message?.user?.name || null
        if (username && !isViewerUsername(username)) {
          return String(username).trim()
        }
      }
      return null
    }

    const extractBuyerNameFromChatNode = (node) => {
      if (!node || typeof node !== 'object') return null
      const lastMessage = node.lastMessage || null
      const deal = lastMessage?.deal || node.deal || null
      const item = deal?.item || null
      const directBuyer = deal?.buyer || node.buyer || item?.buyer || null
      if (directBuyer) {
        const directUsername = directBuyer.username || directBuyer.name || directBuyer.id || null
        if (directUsername && !isViewerUsername(directUsername)) {
          return String(directUsername).trim()
        }
      }
      const candidateUsers = [lastMessage?.user || null, deal?.user || null, node.user || null]
      for (const user of candidateUsers) {
        const username = user?.username || user?.name || null
        if (username && !isViewerUsername(username)) {
          return String(username).trim()
        }
      }
      return null
    }

    const chatsData = await withRetry(
      () => requestUserChatsPage(token, userAgent, viewer.id, { first: limit, after: afterCursor }),
      { label: 'userChats(ui)', retries: 3, shouldRetry: isPlayerokRateLimitError }
    )
    const edges = Array.isArray(chatsData?.edges) ? chatsData.edges : []

    const runPlayerokBatches = async (ids, batchSize, gapMs, worker) => {
      const list = Array.isArray(ids) ? ids : Array.from(ids)
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize)
        await Promise.all(batch.map((id) => worker(id)))
        if (i + batchSize < list.length && gapMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, gapMs))
        }
      }
    }
    const PLAYEROK_DEAL_BATCH = 2
    const PLAYEROK_DEAL_GAP_MS = 450

    const itemIdSet = new Set()
    const dealIdSet = new Set()
    for (const edge of edges) {
      const node = edge && edge.node
      if (!node) continue
      const lastMessage = node.lastMessage || null
      const deal = lastMessage?.deal || node.deal || null
      const item = deal?.item || null
      const itemId = item && item.id != null ? String(item.id) : null
      const dealId = deal && deal.id != null ? String(deal.id) : null
      if (itemId) itemIdSet.add(itemId)
      if (dealId) dealIdSet.add(dealId)
    }

    const itemIdToGame = new Map()
    const titleToGame = new Map()
    if (itemIdSet.size > 0) {
      try {
        const [{ items: activeItems }, { items: completedItems }] = await Promise.all([
          fetchActiveItemsFromPlayerok(token, userAgent),
          fetchCompletedItemsFromPlayerok(token, userAgent),
        ])
        for (const it of [...(activeItems || []), ...(completedItems || [])]) {
          const id = it && it.id != null ? String(it.id) : null
          const gameName = it && it.game ? String(it.game).trim() : ''
          const title = it && (it.title || it.name) ? String(it.title || it.name).trim() : ''
          if (id && gameName && !itemIdToGame.has(id)) {
            itemIdToGame.set(id, gameName)
          }
          if (title && gameName && !titleToGame.has(title)) {
            titleToGame.set(title, gameName)
          }
        }
      } catch (e) {
        // ignore batch errors
      }
    }

    const chatIdToLatestSale = new Map()
    try {
      const { deals: recentDeals } = await fetchDealsFromPlayerok(token, userAgent)
      for (const sale of recentDeals || []) {
        const saleChatId = sale && sale.chatId != null ? String(sale.chatId) : null
        const saleCategory = sale && typeof sale.category === 'string' ? sale.category.trim() : ''
        if (!saleChatId || !saleCategory) continue

        const saleTs = Number(sale.soldAt) || 0
        const prev = chatIdToLatestSale.get(saleChatId)
        if (!prev || saleTs >= prev.soldAt) {
          chatIdToLatestSale.set(saleChatId, { soldAt: saleTs, category: saleCategory })
        }
      }
    } catch (e) {
      // ignore batch errors
    }

    const dealIdToCategory = new Map()
    if (dealIdSet.size > 0) {
      const dealIds = Array.from(dealIdSet)
      try {
        await runPlayerokBatches(dealIds, PLAYEROK_DEAL_BATCH, PLAYEROK_DEAL_GAP_MS, async (id) => {
          try {
            const fullDeal = await withRetry(() => requestDealById(token, userAgent, id), {
              label: 'dealById(userChats)',
              retries: 2,
              shouldRetry: isPlayerokRateLimitError,
            })
            if (!fullDeal) return

            let category = (fullDeal.category && String(fullDeal.category).trim()) || null
            const item = fullDeal.item || null
            if (!category && item) {
              const gameName = (item.game && (item.game.name || item.game.title)) || null
              if (gameName) category = String(gameName).trim()
            }
            if (!category && typeof fullDeal.productKey === 'string') {
              const pk = fullDeal.productKey
              const sepIndex = pk.indexOf('::')
              if (sepIndex > 0) {
                const gameFromPk = pk.slice(0, sepIndex).trim()
                if (gameFromPk) category = gameFromPk
              }
            }
            if (category) {
              dealIdToCategory.set(String(id), category)
            }
          } catch (e) {
            // ignore single deal errors
          }
        })
      } catch (_) {
        // ignore batch errors
      }
    }

    const chatIdToCategory = new Map()
    const chatIdToBuyerName = new Map()
    const chatsNeedingDealId = []
    const dealIdsToLoad = new Set()

    for (const edge of edges) {
      const node = edge && edge.node
      if (!node) continue
      const lastMessage = node.lastMessage || null
      const deal = lastMessage?.deal || node.deal || null
      const item = deal?.item || null

      if (!deal && !item && lastMessage?.deal?.id) {
        const dealId = String(lastMessage.deal.id)
        dealIdsToLoad.add(dealId)
        chatsNeedingDealId.push({ chatId: node.id, dealId })
      } else if (!deal && !item) {
        chatsNeedingDealId.push({ chatId: node.id, dealId: null })
      }
    }

    if (dealIdsToLoad.size > 0) {
      try {
        await runPlayerokBatches(
          Array.from(dealIdsToLoad),
          PLAYEROK_DEAL_BATCH,
          PLAYEROK_DEAL_GAP_MS,
          async (dealId) => {
            try {
              if (dealIdToCategory.has(dealId)) {
                return
              }
              const foundDeal = await withRetry(() => requestDealById(token, userAgent, dealId), {
                label: 'dealById(userChats-fromLastMessage)',
                retries: 1,
                shouldRetry: isPlayerokRateLimitError,
              })
              if (foundDeal) {
                let dealCategory = (foundDeal.category && String(foundDeal.category).trim()) || null
                const dealItem = foundDeal.item || null
                if (!dealCategory && dealItem) {
                  const gameName =
                    (dealItem.game && (dealItem.game.name || dealItem.game.title)) || null
                  if (gameName) dealCategory = String(gameName).trim()
                }
                if (!dealCategory && typeof foundDeal.productKey === 'string') {
                  const pk = foundDeal.productKey
                  const sepIndex = pk.indexOf('::')
                  if (sepIndex > 0) {
                    const gameFromPk = pk.slice(0, sepIndex).trim()
                    if (gameFromPk) dealCategory = gameFromPk
                  }
                }
                if (dealCategory) {
                  dealIdToCategory.set(dealId, dealCategory)
                }
              }
            } catch (e) {
              // ignore found deal errors
            }
          }
        )
      } catch (e) {
        // ignore batch errors
      }
    }

    const chatsNeedingFullInfo = chatsNeedingDealId.filter((c) => !c.dealId).map((c) => c.chatId)
    if (chatsNeedingFullInfo.length > 0) {
      try {
        const BATCH_SIZE = 2
        for (let i = 0; i < chatsNeedingFullInfo.length; i += BATCH_SIZE) {
          const batch = chatsNeedingFullInfo.slice(i, i + BATCH_SIZE)
          await Promise.all(
            batch.map(async (chatId) => {
              try {
                const fullChat = await withRetry(
                  () => requestChatById(token, userAgent, chatId),
                  { label: 'chatById(userChats)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                )

                let category = null
                let dealIdFromChat = null

                if (fullChat) {
                  const chatDeal = fullChat.deal || null
                  const chatItem = chatDeal?.item || null

                  if (chatItem && chatItem.game) {
                    category = (chatItem.game.name || chatItem.game.title || '').trim() || null
                  }
                  if (!category && chatItem && chatItem.category) {
                    category = (chatItem.category.name || chatItem.category.title || '').trim() || null
                  }
                  if (!category && chatDeal) {
                    if (typeof chatDeal.category === 'string') {
                      category = chatDeal.category.trim() || null
                    }
                    if (!category && typeof chatDeal.productKey === 'string') {
                      const pk = chatDeal.productKey
                      const sepIndex = pk.indexOf('::')
                      if (sepIndex > 0) {
                        const gameFromPk = pk.slice(0, sepIndex).trim()
                        if (gameFromPk) {
                          category = gameFromPk
                        }
                      }
                    }
                    if (chatDeal.id) {
                      dealIdFromChat = String(chatDeal.id)
                      if (!category && !dealIdToCategory.has(dealIdFromChat)) {
                        try {
                          const foundDeal = await withRetry(
                            () => requestDealById(token, userAgent, dealIdFromChat),
                            {
                              label: 'dealById(userChats-fromFullChat)',
                              retries: 1,
                              shouldRetry: isPlayerokRateLimitError,
                            }
                          )
                          if (foundDeal) {
                            let dealCategory =
                              (foundDeal.category && String(foundDeal.category).trim()) || null
                            const dealItem = foundDeal.item || null
                            if (!dealCategory && dealItem) {
                              const gameName =
                                (dealItem.game && (dealItem.game.name || dealItem.game.title)) ||
                                null
                              if (gameName) dealCategory = String(gameName).trim()
                            }
                            if (!dealCategory && typeof foundDeal.productKey === 'string') {
                              const pk = foundDeal.productKey
                              const sepIndex = pk.indexOf('::')
                              if (sepIndex > 0) {
                                const gameFromPk = pk.slice(0, sepIndex).trim()
                                if (gameFromPk) dealCategory = gameFromPk
                              }
                            }
                            if (dealCategory) {
                              dealIdToCategory.set(dealIdFromChat, dealCategory)
                              category = dealCategory
                            }
                          }
                        } catch (e) {
                          // ignore found deal errors
                        }
                      } else if (dealIdToCategory.has(dealIdFromChat)) {
                        category = dealIdToCategory.get(dealIdFromChat)
                      }
                    }
                  }
                }

                if (!category || !chatIdToBuyerName.has(String(chatId))) {
                  try {
                    const messagesData = await withRetry(
                      () => requestChatMessagesPage(token, userAgent, chatId, null, 10),
                      {
                        label: 'chatMessages(userChats)',
                        retries: 1,
                        shouldRetry: isPlayerokRateLimitError,
                      }
                    )
                    const messages = Array.isArray(messagesData?.messages) ? messagesData.messages : []
                    const buyerNameFromMessages = extractBuyerNameFromMessages(messages)
                    if (buyerNameFromMessages) {
                      chatIdToBuyerName.set(String(chatId), buyerNameFromMessages)
                    }
                    if (messages.length > 0) {
                      for (const msg of messages) {
                        const foundDealId = msg?.dealId ? String(msg.dealId) : null
                        if (!foundDealId) continue
                        if (!dealIdToCategory.has(foundDealId)) {
                          try {
                            const foundDeal = await withRetry(() => requestDealById(token, userAgent, foundDealId), {
                              label: 'dealById(userChats-fromMsg)',
                              retries: 1,
                              shouldRetry: isPlayerokRateLimitError,
                            })
                            if (foundDeal) {
                              let dealCategory =
                                (foundDeal.category && String(foundDeal.category).trim()) || null
                              const dealItem = foundDeal.item || null
                              if (!dealCategory && dealItem) {
                                const gameName =
                                  (dealItem.game && (dealItem.game.name || dealItem.game.title)) || null
                                if (gameName) dealCategory = String(gameName).trim()
                              }
                              if (!dealCategory && typeof foundDeal.productKey === 'string') {
                                const pk = foundDeal.productKey
                                const sepIndex = pk.indexOf('::')
                                if (sepIndex > 0) {
                                  const gameFromPk = pk.slice(0, sepIndex).trim()
                                  if (gameFromPk) dealCategory = gameFromPk
                                }
                              }
                              if (dealCategory) {
                                dealIdToCategory.set(foundDealId, dealCategory)
                                category = dealCategory
                                break
                              }
                            }
                          } catch (e) {
                            // ignore found deal errors
                          }
                        } else {
                          category = dealIdToCategory.get(foundDealId)
                          if (category) break
                        }
                      }
                    }
                  } catch (e) {
                    // ignore chat messages errors
                  }
                }

                if (category) {
                  chatIdToCategory.set(String(chatId), category)
                }
              } catch (e) {
                // ignore chatById errors
              }
            })
          )

          if (i + BATCH_SIZE < chatsNeedingFullInfo.length) {
            await new Promise((resolve) => setTimeout(resolve, 450))
          }
        }
      } catch (e) {
        // ignore batch errors
      }
    }

    const toUnreadCount = (value) => {
      if (value == null) return null
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed < 0) return null
      return Math.trunc(parsed)
    }

    const list = edges
      .map((edge) => edge && edge.node)
      .filter(Boolean)
      .map((node) => {
        const lastMessage = node.lastMessage || null
        const deal = lastMessage?.deal || node.deal || null
        const item = deal?.item || null
        const buyer = deal?.buyer || node.buyer || null
        const chatId = node.id != null ? String(node.id) : null
        const latestSale = chatId ? chatIdToLatestSale.get(chatId) : null

        let buyerName = extractBuyerNameFromChatNode(node)
        if (!buyerName && chatId && chatIdToBuyerName.has(chatId)) {
          buyerName = chatIdToBuyerName.get(chatId)
        }

        const itemTitle = (item && (item.title || item.name)) || (deal && deal.productTitle) || null
        const itemImageUrl = item ? extractItemImageUrl(item) : null

        const categoryDebugInfo = {
          chatId: node.id,
          hasItem: !!item,
          hasDeal: !!deal,
          hasNode: !!node,
          itemGame: item?.game ? (item.game.name || item.game.title) : null,
          itemCategory: item?.category ? (item.category.name || item.category.title) : null,
          nodeGame: node?.game ? (node.game.name || node.game.title) : null,
          nodeCategory: node?.category ? (node.category.name || node.category.title) : null,
          dealCategory: deal && typeof deal.category === 'string' ? deal.category : null,
          dealProductKey: deal && typeof deal.productKey === 'string' ? deal.productKey : null,
          itemId: item && item.id != null ? String(item.id) : null,
          dealId: deal && deal.id != null ? String(deal.id) : null,
          itemTitle: itemTitle || null,
          latestSaleCategory: latestSale?.category || null,
          latestSaleSoldAt: latestSale?.soldAt || null,
        }

        let category =
          (latestSale && latestSale.category) ||
          (item && item.game && (item.game.name || item.game.title)) ||
          (item && item.category && (item.category.name || item.category.title)) ||
          (node && node.game && (node.game.name || node.game.title)) ||
          (node && node.category && (node.category.name || node.category.title)) ||
          (deal && typeof deal.category === 'string' && deal.category) ||
          null

        let categorySource = null
        if (category) {
          categorySource = latestSale?.category ? 'latest sale by chatId' : 'item.game или node.game или deal.category'
        }

        if (!category && deal && typeof deal.productKey === 'string') {
          const pk = deal.productKey
          const sepIndex = pk.indexOf('::')
          if (sepIndex > 0) {
            category = pk.slice(0, sepIndex).trim() || null
            if (category) categorySource = 'deal.productKey'
          }
        }

        if (!category) {
          const itemId = item && item.id != null ? String(item.id) : null
          if (itemId && itemIdToGame.has(itemId)) {
            category = itemIdToGame.get(itemId)
            if (category) categorySource = 'itemIdToGame map'
          }
        }

        if (!category && deal && deal.id != null) {
          const did = String(deal.id)
          if (dealIdToCategory.has(did)) {
            category = dealIdToCategory.get(did)
            if (category) categorySource = 'dealIdToCategory map'
          }
        }

        if (!category && !deal && !item && node.id != null) {
          const chatId = String(node.id)
          if (lastMessage && lastMessage.deal && lastMessage.deal.id) {
            const dealIdFromMessage = String(lastMessage.deal.id)
            if (dealIdToCategory.has(dealIdFromMessage)) {
              category = dealIdToCategory.get(dealIdFromMessage)
              if (category) {
                categorySource = 'dealIdToCategory map (from lastMessage.deal)'
              }
            }
          }
          if (!category && chatIdToCategory.has(chatId)) {
            category = chatIdToCategory.get(chatId)
            if (category) {
              categorySource = 'chatIdToCategory map (requestChatById)'
            }
          }
        }

        if (!category && itemTitle && typeof itemTitle === 'string') {
          const title = itemTitle.trim()
          if (title && titleToGame.has(title)) {
            category = titleToGame.get(title)
            if (category) {
              categorySource = 'titleToGame map'
            }
          }
          if (!category) {
            const commonGames = [
              'Clash of Clans',
              'Clash Royale',
              'Brawl Stars',
              'Hay Day',
              'Boom Beach',
              'PUBG',
              'PUBG Mobile',
              'Call of Duty',
              'Free Fire',
              'Fortnite',
              'CS:GO',
              'CS2',
              'Counter-Strike',
              'Dota 2',
              'League of Legends',
              'Valorant',
              'Apex Legends',
              'Genshin Impact',
              'Honkai',
              'Star Rail',
              'World of Tanks',
              'World of Warships',
              'War Thunder',
              'Minecraft',
              'Roblox',
              'Among Us',
              'Fall Guys',
              'Mobile Legends',
              'Wild Rift',
              'Arena of Valor',
              'Heroes of the Storm',
              'Overwatch',
              'YouTube',
              'Claude',
              'ChatGPT',
              'ЧатГПТ',
            ]
            for (const game of commonGames) {
              if (title.toLowerCase().includes(game.toLowerCase())) {
                category = game
                categorySource = 'itemTitle (common games)'
                break
              }
            }
          }
        }

        if (category && typeof category === 'string') {
          category = category.trim()
          if (!category) category = null
        }

        categoryDebugInfo.finalCategory = category
        categoryDebugInfo.categorySource = categorySource

        if (!category || (typeof category === 'string' && !category.trim())) {
          let fallbackCategory = null
          if (itemTitle && typeof itemTitle === 'string' && itemTitle.trim()) {
            const title = itemTitle.trim()
            const commonGames = [
              'Clash of Clans',
              'Clash Royale',
              'Brawl Stars',
              'Hay Day',
              'Boom Beach',
              'PUBG',
              'PUBG Mobile',
              'Call of Duty',
              'Free Fire',
              'Fortnite',
              'CS:GO',
              'CS2',
              'Counter-Strike',
              'Dota 2',
              'League of Legends',
              'Valorant',
              'Apex Legends',
              'Genshin Impact',
              'Honkai',
              'Star Rail',
              'World of Tanks',
              'World of Warships',
              'War Thunder',
              'Minecraft',
              'Roblox',
              'Among Us',
              'Fall Guys',
              'Mobile Legends',
              'Wild Rift',
              'Arena of Valor',
              'Heroes of the Storm',
              'Overwatch',
              'YouTube',
              'Claude',
              'ChatGPT',
              'ЧатГПТ',
              'Telegram',
              'Discord',
            ]
            for (const game of commonGames) {
              if (title.toLowerCase().includes(game.toLowerCase())) {
                fallbackCategory = game
                break
              }
            }
            if (!fallbackCategory) {
              const words = title.split(/\s+/).filter((w) => w.length > 0)
              if (words.length > 0) {
                let candidate = words.slice(0, 3).join(' ')
                if (candidate.length > 50) {
                  candidate = candidate.substring(0, 50).trim()
                }
                if (candidate) fallbackCategory = candidate
              }
            }
          }

          if (!fallbackCategory) {
            let messageText = null
            if (lastMessage && lastMessage.text && typeof lastMessage.text === 'string') {
              messageText = lastMessage.text.trim()
            }
            if (messageText) {
              const commonGames = [
                'Clash of Clans',
                'Clash Royale',
                'Brawl Stars',
                'Hay Day',
                'Boom Beach',
                'PUBG',
                'PUBG Mobile',
                'Call of Duty',
                'Free Fire',
                'Fortnite',
                'CS:GO',
                'CS2',
                'Counter-Strike',
                'Dota 2',
                'League of Legends',
                'Valorant',
                'Apex Legends',
                'Genshin Impact',
                'Honkai',
                'Star Rail',
                'World of Tanks',
                'World of Warships',
                'War Thunder',
                'Minecraft',
                'Roblox',
                'Among Us',
                'Fall Guys',
                'Mobile Legends',
                'Wild Rift',
                'Arena of Valor',
                'Heroes of the Storm',
                'Overwatch',
                'YouTube',
                'Claude',
                'ChatGPT',
                'ЧатГПТ',
                'Telegram',
                'Discord',
              ]
              for (const game of commonGames) {
                if (messageText.toLowerCase().includes(game.toLowerCase())) {
                  fallbackCategory = game
                  break
                }
              }
            }
          }

          if (!fallbackCategory || (typeof fallbackCategory === 'string' && !fallbackCategory.trim())) {
            if (itemTitle && typeof itemTitle === 'string' && itemTitle.trim()) {
              const words = itemTitle.trim().split(/\s+/).filter((w) => w.length > 0)
              if (words.length > 0) {
                fallbackCategory = words.slice(0, 2).join(' ')
              }
            }
          }

          if (fallbackCategory && (typeof fallbackCategory === 'string' && fallbackCategory.trim())) {
            category = fallbackCategory
            categorySource = itemTitle
              ? 'itemTitle fallback'
              : lastMessage?.text
                ? 'lastMessage fallback'
                : 'itemTitle words fallback'
          }
        }

        if (!category || (typeof category === 'string' && !category.trim())) {
          if (itemTitle && typeof itemTitle === 'string' && itemTitle.trim()) {
            const words = itemTitle.trim().split(/\s+/).filter((w) => w.length > 0)
            if (words.length > 0) {
              category = words.slice(0, 2).join(' ')
            }
          }
          if (!category || (typeof category === 'string' && !category.trim())) {
            category = 'Категория не определена'
          }
        }

        const status = deal && typeof deal.status === 'string' ? deal.status : null
        const unreadCount = toUnreadCount(
          node.unreadMessagesCount ?? node.unreadCount ?? node.unread_messages_count
        )
        return {
          id: node.id,
          unreadCount,
          lastMessageId: lastMessage?.id || null,
          lastMessageText: lastMessage?.text || null,
          lastMessageCreatedAt: lastMessage?.createdAt || null,
          dealId: deal?.id || null,
          itemId: item?.id || null,
          itemTitle,
          itemImageUrl,
          category,
          status,
          buyerName: buyerName || null,
          isHidden: node.id != null && hiddenSet.has(String(node.id)),
        }
      })

    const categoryFromItemNode = (itemNode) => {
      if (!itemNode || typeof itemNode !== 'object') return null
      let cat =
        (itemNode.game && (itemNode.game.name || itemNode.game.title)) ||
        (itemNode.category && (itemNode.category.name || itemNode.category.title)) ||
        null
      if (cat && String(cat).trim()) return String(cat).trim()
      return null
    }
    const rememberItemCategory = (iid, itemNode) => {
      const cat = categoryFromItemNode(itemNode)
      if (cat && !itemIdToGame.has(iid)) itemIdToGame.set(iid, cat)
      return cat
    }

    const resolveCategoryFromDeal = async (dealId) => {
      const did = dealId != null ? String(dealId) : ''
      if (!did) return null
      if (dealIdToCategory.has(did)) return dealIdToCategory.get(did) || null
      try {
        const fullDeal = await withRetry(() => requestDealById(token, userAgent, did), {
          label: 'dealById(userChats-deepResolve)',
          retries: 2,
          shouldRetry: isPlayerokRateLimitError,
        })
        if (!fullDeal) return null
        let dealCategory = (fullDeal.category && String(fullDeal.category).trim()) || null
        const dealItem = fullDeal.item || null
        if (!dealCategory && dealItem) {
          const gameName = (dealItem.game && (dealItem.game.name || dealItem.game.title)) || null
          if (gameName) dealCategory = String(gameName).trim()
        }
        if (!dealCategory && typeof fullDeal.productKey === 'string') {
          const sepIndex = fullDeal.productKey.indexOf('::')
          if (sepIndex > 0) {
            const gameFromPk = fullDeal.productKey.slice(0, sepIndex).trim()
            if (gameFromPk) dealCategory = gameFromPk
          }
        }
        if (dealCategory) {
          dealIdToCategory.set(did, dealCategory)
          return dealCategory
        }
      } catch (_) {
        // ignore deep deal resolve error
      }
      return null
    }

    const resolveCategoryFromItemMaps = (chat) => {
      const iid = chat.itemId != null ? String(chat.itemId) : null
      if (iid && itemIdToGame.has(iid)) return itemIdToGame.get(iid) || null
      const title =
        chat.itemTitle && typeof chat.itemTitle === 'string' ? chat.itemTitle.trim() : ''
      if (title && titleToGame.has(title)) return titleToGame.get(title) || null
      return null
    }

    const resolveCategoryFromItemApi = async (chat) => {
      if (!requestItemById || chat.itemId == null) return null
      const iid = String(chat.itemId)
      const cached = resolveCategoryFromItemMaps(chat)
      if (cached) return cached
      try {
        const itemNode = await withRetry(() => requestItemById(token, userAgent, iid), {
          label: 'itemById(userChats-deepResolve)',
          retries: 1,
          shouldRetry: isPlayerokRateLimitError,
        })
        return rememberItemCategory(iid, itemNode)
      } catch (_) {
        return null
      }
    }

    const resolveCategoryFromChatMessagesHistory = async (chatId) => {
      const cid = chatId != null ? String(chatId) : ''
      if (!cid) return null

      let afterCursor = null
      const maxPages = 6
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        let messagesData = null
        try {
          messagesData = await withRetry(
            () => requestChatMessagesPage(token, userAgent, cid, afterCursor, 24),
            {
              label: 'chatMessages(userChats-deepHistory)',
              retries: 2,
              shouldRetry: isPlayerokRateLimitError,
            }
          )
        } catch (_) {
          break
        }

        const messages = Array.isArray(messagesData?.messages) ? messagesData.messages : []
        for (const msg of messages) {
          const dealIdFromMsg = msg?.dealId != null ? String(msg.dealId) : null
          if (dealIdFromMsg) {
            const fromDeal = await resolveCategoryFromDeal(dealIdFromMsg)
            if (fromDeal) return fromDeal
          }
          const fromText = categoryFromTextHints(msg?.text || '')
          if (fromText) return fromText
        }

        const hasNext = Boolean(messagesData?.pageInfo?.hasNextPage)
        afterCursor = hasNext ? (messagesData?.pageInfo?.endCursor || null) : null
        if (!afterCursor) break
      }

      return null
    }

    const resolveCategoryByDeepChatLookup = async (chat) => {
      const chatId = chat?.id != null ? String(chat.id) : ''
      if (!chatId) return null

      if (chat.dealId != null) {
        const fromDeal = await resolveCategoryFromDeal(chat.dealId)
        if (fromDeal) return fromDeal
      }

      const fromMapsEarly = resolveCategoryFromItemMaps(chat)
      if (fromMapsEarly) return fromMapsEarly

      try {
        const fullChat = await withRetry(() => requestChatById(token, userAgent, chatId), {
          label: 'chatById(userChats-deepResolve)',
          retries: 2,
          shouldRetry: isPlayerokRateLimitError,
        })

        const chatDeal = fullChat?.deal || null
        const chatItem = chatDeal?.item || null
        let category =
          (chatItem?.game && (chatItem.game.name || chatItem.game.title)) ||
          (chatItem?.category && (chatItem.category.name || chatItem.category.title)) ||
          (typeof chatDeal?.category === 'string' && chatDeal.category) ||
          null

        if (!category && typeof chatDeal?.productKey === 'string') {
          const sepIndex = chatDeal.productKey.indexOf('::')
          if (sepIndex > 0) {
            category = chatDeal.productKey.slice(0, sepIndex).trim() || null
          }
        }
        if (category && String(category).trim()) {
          return String(category).trim()
        }

        if (chatDeal?.id != null) {
          const fromDeal = await resolveCategoryFromDeal(chatDeal.id)
          if (fromDeal) return fromDeal
        }
      } catch (_) {
        // ignore deep chat resolve error
      }

      const fromMaps = resolveCategoryFromItemMaps(chat)
      if (fromMaps) return fromMaps

      const fromItemApi = await resolveCategoryFromItemApi(chat)
      if (fromItemApi) return fromItemApi

      const fromMessagesHistory = await resolveCategoryFromChatMessagesHistory(chatId)
      if (fromMessagesHistory) return fromMessagesHistory

      return null
    }

    const chatsNeedingDeepResolve = list.filter((chat) => {
      const category = typeof chat?.category === 'string' ? chat.category.trim() : ''
      return !category || category === 'Категория не определена'
    })
    if (chatsNeedingDeepResolve.length > 0) {
      const ITEM_PREFETCH_GAP_MS = 520
      const MAX_ITEM_PREFETCH_PER_REQUEST = 36
      if (requestItemById) {
        const prefetchIds = []
        const seenPrefetch = new Set()
        for (const chat of chatsNeedingDeepResolve) {
          const iid = chat.itemId != null ? String(chat.itemId) : null
          if (!iid || itemIdToGame.has(iid) || seenPrefetch.has(iid)) continue
          seenPrefetch.add(iid)
          prefetchIds.push(iid)
        }
        const toPrefetch = prefetchIds.slice(0, MAX_ITEM_PREFETCH_PER_REQUEST)
        for (let pi = 0; pi < toPrefetch.length; pi += 1) {
          const iid = toPrefetch[pi]
          try {
            const itemNode = await withRetry(() => requestItemById(token, userAgent, iid), {
              label: 'itemById(userChats-deepPrefetch)',
              retries: 1,
              shouldRetry: isPlayerokRateLimitError,
            })
            rememberItemCategory(iid, itemNode)
          } catch (_) {
            // ignore prefetch errors
          }
          if (pi + 1 < toPrefetch.length) {
            await new Promise((resolve) => setTimeout(resolve, ITEM_PREFETCH_GAP_MS))
          }
        }
      }

      const BATCH_SIZE = 1
      const DEEP_RESOLVE_CHAT_GAP_MS = 650
      for (let i = 0; i < chatsNeedingDeepResolve.length; i += BATCH_SIZE) {
        const batch = chatsNeedingDeepResolve.slice(i, i + BATCH_SIZE)
        await Promise.all(
          batch.map(async (chat) => {
            const resolvedCategory = await resolveCategoryByDeepChatLookup(chat)
            if (!resolvedCategory) return
            const chatIndex = list.findIndex((c) => c.id === chat.id)
            if (chatIndex !== -1) {
              list[chatIndex].category = resolvedCategory
            }
          })
        )
        if (i + BATCH_SIZE < chatsNeedingDeepResolve.length) {
          await new Promise((resolve) => setTimeout(resolve, DEEP_RESOLVE_CHAT_GAP_MS))
        }
      }
    }

    const chatsNeedingBuyerName = list.filter((chat) => !chat.buyerName && chat.id != null)
    if (chatsNeedingBuyerName.length > 0) {
      try {
        const BATCH_SIZE = 2
        for (let i = 0; i < chatsNeedingBuyerName.length; i += BATCH_SIZE) {
          const batch = chatsNeedingBuyerName.slice(i, i + BATCH_SIZE)
          await Promise.all(
            batch.map(async (chat) => {
              try {
                const chatId = String(chat.id)
                if (chatIdToBuyerName.has(chatId)) {
                  return
                }
                const messagesData = await withRetry(
                  () => requestChatMessagesPage(token, userAgent, chatId, null, 10),
                  { label: 'chatMessages(userChats-buyer)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                )
                const messages = Array.isArray(messagesData?.messages) ? messagesData.messages : []
                const buyerName = extractBuyerNameFromMessages(messages)
                if (buyerName) {
                  chatIdToBuyerName.set(chatId, buyerName)
                }
              } catch (e) {
                // ignore chatMessages errors
              }
            })
          )
          if (i + BATCH_SIZE < chatsNeedingBuyerName.length) {
            await new Promise((resolve) => setTimeout(resolve, 400))
          }
        }

        for (const chat of chatsNeedingBuyerName) {
          const resolvedBuyerName = chatIdToBuyerName.get(String(chat.id)) || null
          if (resolvedBuyerName) {
            chat.buyerName = resolvedBuyerName
          }
        }
      } catch (e) {
        // ignore buyer name resolution errors
      }
    }

    const chatsNeedingMapping = list.filter((chat) => {
      const cat = chat.category
      return (
        !cat ||
        (typeof cat === 'string' &&
          (!cat.trim() ||
            cat === 'Категория не определена' ||
            cat.includes('fallback') ||
            (chat.itemTitle && !titleToGame.has(chat.itemTitle.trim()))))
      )
    })

    if (chatsNeedingMapping.length > 0) {
      for (const chat of chatsNeedingMapping) {
        let category = chat.category
        const chatIndex = list.findIndex((c) => c.id === chat.id)
        if (chatIndex === -1) continue

        if (category && category !== 'Категория не определена' && !category.includes('fallback') && category.trim()) {
          if (chat.itemId) {
            const betterCategory = itemIdToGame.get(String(chat.itemId))
            if (betterCategory && betterCategory !== category) {
              category = betterCategory
            }
          }
          if (chat.itemTitle && typeof chat.itemTitle === 'string') {
            const title = chat.itemTitle.trim()
            const betterCategory = titleToGame.get(title)
            if (betterCategory && betterCategory !== category) {
              category = betterCategory
            }
          }
        } else {
          if ((!category || category === 'Категория не определена') && chat.id != null) {
            const retryChatId = String(chat.id)
            try {
              const latestSaleRetry = chatIdToLatestSale.get(retryChatId)
              if (latestSaleRetry?.category) {
                category = latestSaleRetry.category
              }

              if (!category) {
                const fullChat = await withRetry(
                  () => requestChatById(token, userAgent, retryChatId),
                  { label: 'chatById(userChats-retryCategory)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                )

                const retryDeal = fullChat?.deal || null
                const retryItem = retryDeal?.item || null

                category =
                  (retryItem?.game && (retryItem.game.name || retryItem.game.title)) ||
                  (retryItem?.category && (retryItem.category.name || retryItem.category.title)) ||
                  (typeof retryDeal?.category === 'string' && retryDeal.category) ||
                  null

                if (!category && typeof retryDeal?.productKey === 'string') {
                  const sepIndex = retryDeal.productKey.indexOf('::')
                  if (sepIndex > 0) {
                    category = retryDeal.productKey.slice(0, sepIndex).trim() || null
                  }
                }

                if (!category && retryDeal?.id != null) {
                  const retryDealId = String(retryDeal.id)
                  if (dealIdToCategory.has(retryDealId)) {
                    category = dealIdToCategory.get(retryDealId) || null
                  } else {
                    try {
                      const fullDeal = await withRetry(
                        () => requestDealById(token, userAgent, retryDealId),
                        { label: 'dealById(userChats-retryCategory)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                      )
                      if (fullDeal) {
                        category =
                          (fullDeal.category && String(fullDeal.category).trim()) ||
                          (fullDeal.item?.game && (fullDeal.item.game.name || fullDeal.item.game.title)) ||
                          null
                        if (!category && typeof fullDeal.productKey === 'string') {
                          const sepIndex = fullDeal.productKey.indexOf('::')
                          if (sepIndex > 0) {
                            category = fullDeal.productKey.slice(0, sepIndex).trim() || null
                          }
                        }
                        if (category) {
                          dealIdToCategory.set(retryDealId, category)
                        }
                      }
                    } catch (e) {
                      // ignore retryDeal errors
                    }
                  }
                }

                if (category) {
                  chatIdToCategory.set(retryChatId, String(category).trim())
                }
              }

              if (!category) {
                try {
                  const messagesData = await withRetry(
                    () => requestChatMessagesPage(token, userAgent, retryChatId, null, 12),
                    { label: 'chatMessages(userChats-retryCategory)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                  )
                  const messages = Array.isArray(messagesData?.messages) ? messagesData.messages : []
                  for (const msg of messages) {
                    const retryDealId =
                      (msg?.dealId != null ? String(msg.dealId) : null) || (msg?.deal?.id != null ? String(msg.deal.id) : null)
                    if (!retryDealId) continue

                    if (dealIdToCategory.has(retryDealId)) {
                      category = dealIdToCategory.get(retryDealId) || null
                      if (category) break
                    }

                    try {
                      const fullDeal = await withRetry(
                        () => requestDealById(token, userAgent, retryDealId),
                        { label: 'dealById(userChats-retryCategoryFromMsg)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                      )
                      if (!fullDeal) continue

                      category =
                        (fullDeal.category && String(fullDeal.category).trim()) ||
                        (fullDeal.item?.game && (fullDeal.item.game.name || fullDeal.item.game.title)) ||
                        null

                      if (!category && typeof fullDeal.productKey === 'string') {
                        const sepIndex = fullDeal.productKey.indexOf('::')
                        if (sepIndex > 0) {
                          category = fullDeal.productKey.slice(0, sepIndex).trim() || null
                        }
                      }

                      if (category) {
                        dealIdToCategory.set(retryDealId, category)
                        chatIdToCategory.set(retryChatId, category)
                        break
                      }
                    } catch (e) {
                      // ignore retryDeal from message errors
                    }
                  }
                } catch (e) {
                  // ignore messagesData errors
                }
              }
            } catch (e) {
              // ignore retry category errors
            }
          }

          if (!category && chat.itemId) {
            category = itemIdToGame.get(String(chat.itemId)) || null
          }
          if (!category && chat.itemTitle && typeof chat.itemTitle === 'string') {
            const title = chat.itemTitle.trim()
            category = titleToGame.get(title) || null
          }

          if (!category || (typeof category === 'string' && !category.trim())) {
            if (chat.itemTitle && typeof chat.itemTitle === 'string' && chat.itemTitle.trim()) {
              const title = chat.itemTitle.trim()
              const commonGames = [
                'Clash of Clans',
                'Clash Royale',
                'Brawl Stars',
                'Hay Day',
                'Boom Beach',
                'PUBG',
                'PUBG Mobile',
                'Call of Duty',
                'Free Fire',
                'Fortnite',
                'CS:GO',
                'CS2',
                'Counter-Strike',
                'Dota 2',
                'League of Legends',
                'Valorant',
                'Apex Legends',
                'Genshin Impact',
                'Honkai',
                'Star Rail',
                'World of Tanks',
                'World of Warships',
                'War Thunder',
                'Minecraft',
                'Roblox',
                'Among Us',
                'Fall Guys',
                'Mobile Legends',
                'Wild Rift',
                'Arena of Valor',
                'Heroes of the Storm',
                'Overwatch',
                'YouTube',
                'Claude',
                'ChatGPT',
                'ЧатГПТ',
                'Telegram',
                'Discord',
              ]
              for (const game of commonGames) {
                if (title.toLowerCase().includes(game.toLowerCase())) {
                  category = game
                  break
                }
              }
              if (!category || (typeof category === 'string' && !category.trim())) {
                const words = title.split(/\s+/).filter((w) => w.length > 0)
                if (words.length > 0) {
                  let candidate = words.slice(0, 3).join(' ')
                  if (candidate.length > 50) candidate = candidate.substring(0, 50).trim()
                  if (candidate) category = candidate
                }
              }
            }
            if (!category || (typeof category === 'string' && !category.trim())) {
              category = 'Категория не определена'
            }
          }
        }

        if (category && category !== chat.category) {
          list[chatIndex].category = category
        }
      }
    }

    // Единая и детерминированная финализация категории для всех чатов.
    // Стабилизирует результат, даже если часть промежуточных источников отдала неполные данные.
    for (const chat of list) {
      let category = normalizeCategory(chat.category)

      if (!category) {
        category = normalizeCategory(chatIdToLatestSale.get(String(chat.id || ''))?.category || null)
      }
      if (!category && chat.dealId != null) {
        category = normalizeCategory(dealIdToCategory.get(String(chat.dealId)) || null)
      }
      if (!category && chat.itemId != null) {
        category = normalizeCategory(itemIdToGame.get(String(chat.itemId)) || null)
      }
      if (!category && chat.itemTitle) {
        category = normalizeCategory(titleToGame.get(String(chat.itemTitle).trim()) || null)
      }
      if (!category && chat.itemTitle) {
        category = categoryFromTextHints(chat.itemTitle)
      }
      if (!category && chat.lastMessageText) {
        category = categoryFromTextHints(chat.lastMessageText)
      }
      if (!category && chat.itemTitle) {
        category = shortCategoryFromText(chat.itemTitle, 2)
      }
      // Не используем произвольные первые слова из последнего сообщения:
      // это может давать шум вроде "Хорошо!" как категорию.

      if (!category && chat.dealId != null) {
        // Последняя попытка: прямой запрос сделки, если всё еще не удалось.
        try {
          const fullDeal = await withRetry(() => requestDealById(token, userAgent, String(chat.dealId)), {
            label: 'dealById(userChats-finalNormalize)',
            retries: 2,
            shouldRetry: isPlayerokRateLimitError,
          })
          category =
            normalizeCategory(fullDeal?.category) ||
            normalizeCategory(fullDeal?.item?.game?.name || fullDeal?.item?.game?.title || null) ||
            normalizeCategory(fullDeal?.item?.category?.name || fullDeal?.item?.category?.title || null) ||
            categoryFromProductKey(fullDeal?.productKey)
        } catch (_) {
          // ignore final normalize deal error
        }
      }

      chat.category = category || DEFAULT_CATEGORY
    }

    const pageInfo = (chatsData && chatsData.pageInfo) || {}

    const response = {
      list,
      pageInfo: {
        hasNextPage: Boolean(pageInfo.hasNextPage),
        endCursor: pageInfo.endCursor || null,
      },
    }
    if (typeof setChatsSnapshotCache === 'function') {
      setChatsSnapshotCache(currentUserId, cacheKey, response)
    }
    return { statusCode: 200, data: response }
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Не удалось загрузить чаты с Playerok'
    return { statusCode: 500, data: { error: message } }
  }
}

module.exports = { handleChats }

