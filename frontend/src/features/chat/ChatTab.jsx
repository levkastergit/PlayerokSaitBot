import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { logChatLogging } from '../../debug/chatLoggingLog.js'
import { logChatMessagesGap } from '../../debug/chatMessagesGapLog.js'
import { isPlayerokRateLimitMessage, pollDelayAfterErrors } from './chatRequestUtils.js'
import {
  fetchChatDbList,
  fetchChatDbMessages,
  fetchChatDbMessagesBatch,
  markChatDbRead,
  sendChatDbMessage,
  hideChat,
  unhideChat,
  loadCategoryCommandsList,
  requestSupercellCode,
  cancelDeal,
  confirmDeal,
  rescanApprouteChat,
  recheckChatDbChat,
  loadProductSettingsList,
  testChatPurchase,
  sendTestPurchaseMessage,
  sendTestPurchaseEvent,
  automessageImageUrl,
  getProductKey,
  getGroupSettingsKey,
  startChatDbFullScan,
  fetchChatDbFullScanStatus,
  pauseChatDbScan,
  stopChatDbScan,
} from '../../services/playerokApi'

// Синтетические чаты категории «Тест» (имитация покупок, без сайд-эффектов).
const TEST_CHAT_ID = 'synthetic-test'
const TEST_CHAT_BUYER_ID = 'synthetic-test-buyer'
const TEST_CHAT = { id: TEST_CHAT_ID, buyerName: 'Как продавец', category: 'Тест', itemTitle: '' }
const TEST_CHAT_BUYER = { id: TEST_CHAT_BUYER_ID, buyerName: 'Как покупатель', category: 'Тест', itemTitle: '' }
const isTestChatId = (id) => id === TEST_CHAT_ID || id === TEST_CHAT_BUYER_ID

function buildTestDealsFromMessages(messages) {
  const byId = new Map()
  for (const m of Array.isArray(messages) ? messages : []) {
    const dealId = m?.dealId != null ? String(m.dealId).trim() : ''
    if (!dealId) continue
    if (!byId.has(dealId)) {
      byId.set(dealId, {
        dealId,
        label: '',
        hasPaid: false,
        hasSent: false,
        hasConfirmed: false,
      })
    }
    const d = byId.get(dealId)
    const text = String(m?.text || '')
    if (text.includes('Покупка товара:')) {
      const label = text.split('Покупка товара:').slice(1).join('Покупка товара:').trim()
      if (label) d.label = label
    }
    if (text.includes('{{ITEM_PAID}}')) d.hasPaid = true
    if (text.includes('{{ITEM_SENT}}')) d.hasSent = true
    if (text.includes('{{DEAL_CONFIRMED}}') || text.includes('{{DEAL_CONFIRMED_AUTOMATICALLY}}')) {
      d.hasConfirmed = true
    }
  }
  return [...byId.values()]
}

// ----------------------------------------------------------------------------
// «Логика работы» товара: показываем в чате РЕАЛЬНУЮ автоматику, которую бот
// выполнит по купленному товару. Источник истины — рантайм бэкенда
// (handlePaidChat.js / handleChatAutomessage.js), а не наивная копия формы /lot/.
// Поэтому здесь воспроизводятся ключевые правила:
//  - сгруппированный товар = слияние групповой записи и индивидуальной (mergeProductSettings);
//  - порядок autoPlacementOrder соблюдается ТОЛЬКО для текст/время/картинка (t/w/i),
//    а доставка (таблица → API → Supercell → пополнение) идёт фиксированным порядком;
//  - autoCompleteDeal логически OR-ится с autodelivery.autoCompleteDeal;
//  - активность шага считается по фактическим условиям рантайма (непустой текст,
//    наличие привязки/сервиса, временное окно, Supercell-категория).
// ----------------------------------------------------------------------------

// Дефолты сообщений автопополнения — те же, что подставляет бэкенд при пустых полях.
const TOPUP_DEFAULT_MESSAGES = {
  askIdMessage: 'Для пополнения напишите ваш игровой ID/логин.',
  confirmTemplate: 'Подтвердите: ваш ID/логин — {id}. Всё верно? Напишите «да» или «нет».',
  invalidIdMessage: 'ID/логин не прошёл проверку. Пришлите, пожалуйста, корректный ID/логин.',
  successMessage: 'Готово! Пополнение выполнено. Спасибо за покупку.',
}
const SUPERCELL_CODE_DEFAULT_MESSAGE =
  'Запросил код на вашу почту для $game_name, скиньте его пожалуйста сюда в чат, как придет'

// Дефолты сообщений автовыдачи Clode (Claude) — те же, что подставляет бэкенд
// (runClodeRedeemFlow) при пустых полях. Тариф/код берутся из привязанной таблицы.
const CLODE_DEFAULT_MESSAGES = {
  askIdMessage: 'Напишите, пожалуйста, ваш Claude user ID (UUID) для активации.',
  confirmTemplate: 'это ваш id: {id}, да/нет?',
  successMessage: 'Готово! Подписка активирована. Спасибо за покупку.',
}
const CLODE_TIER_LABELS = {
  pro: 'Claude Pro (bbc)',
  max_5x: 'Claude Max 5x (bbc5x)',
  max_20x: 'Claude Max 20x (bbc20x)',
}

// Дефолты сообщений автовыдачи GPT (ChatGPT) — те же, что подставляет бэкенд
// (runGptRedeemFlow). Запрос зависит от inputMode (ссылка/ID/авто).
const GPT_DEFAULT_MESSAGES = {
  askLinkMessage:
    'Пришлите, пожалуйста, ссылку на Google-документ с вашим ChatGPT Access Token (документ должен быть открыт для просмотра «всем, у кого есть ссылка»).',
  askIdMessage:
    'Напишите, пожалуйста, ваш ChatGPT ID (app_user_id в формате UUID) для активации подписки.',
  askAutoMessage:
    'Для активации пришлите ваш ChatGPT ID (UUID) или ссылку на Google-документ с вашим Access Token (документ открыт для просмотра «всем, у кого есть ссылка»).',
  successMessage: 'Готово! Подписка ChatGPT активирована. Спасибо за покупку.',
}
const GPT_INPUT_MODE_LABELS = {
  link: 'ссылка на Google-документ',
  id: 'ChatGPT ID (UUID)',
  auto: 'ID или ссылка на документ',
}

// Каноническое имя игры Supercell — как его подставляет бэкенд
// (getSupercellGameByCategory → gameName). Нужно, чтобы превью «Запрос кода»
// показывало ровно тот текст, что реально отправит бот, даже если категория
// записана по-русски/в нижнем регистре ('бравл старс' → 'Brawl Stars').
const SUPERCELL_GAME_NAME_PATTERNS = [
  { re: /brawl\s*stars|brawlstars|бравл\s*стар/i, label: 'Brawl Stars' },
  { re: /clash\s*royale|clashroyale|клеш\s*роял|клеш\s*рояль/i, label: 'Clash Royale' },
  { re: /clash\s*of\s*clans|clashofclans|\bcoc\b|клеш\s*оф\s*клан|клеш\s*кланс|клеш\s*кленс/i, label: 'Clash of Clans' },
]
function canonicalSupercellGameName(category) {
  const raw = String(category || '').trim()
  if (!raw) return ''
  for (const p of SUPERCELL_GAME_NAME_PATTERNS) {
    if (p.re.test(raw)) return p.label
  }
  return raw
}

/** Слияние autodeliveryApi/autotopupApi (item поверх group) — копия mergeProductSettings бэкенда. */
function mergeWorkApiBlock(itemApi, groupApi) {
  const item = itemApi && typeof itemApi === 'object' ? itemApi : null
  const group = groupApi && typeof groupApi === 'object' ? groupApi : null
  if (!item && !group) return null
  const merged = { ...(group || {}), ...(item || {}) }
  merged.enabled = Boolean(item?.enabled || group?.enabled)
  return merged
}

/**
 * Эффективные настройки товара = слияние групповой записи (база) и индивидуальной
 * (поверх — settingsLabel/groupName/autobump/autodeliveryApi/autotopupApi).
 * Точная копия backend mergeProductSettings, чтобы панель показывала ровно то,
 * что исполнит бот.
 */
function mergeWorkSettings(groupSettings, itemSettings) {
  if (!groupSettings && !itemSettings) return null
  if (!groupSettings) return itemSettings
  if (!itemSettings) return groupSettings
  const merged = {
    ...groupSettings,
    settingsLabel:
      typeof itemSettings.settingsLabel === 'string' && itemSettings.settingsLabel.trim()
        ? itemSettings.settingsLabel.trim()
        : groupSettings.settingsLabel,
    groupName:
      typeof itemSettings.groupName === 'string' && itemSettings.groupName.trim()
        ? itemSettings.groupName
        : groupSettings.groupName,
  }
  if (itemSettings.autobump && typeof itemSettings.autobump === 'object') {
    merged.autobump = itemSettings.autobump
  }
  const api = mergeWorkApiBlock(itemSettings.autodeliveryApi, groupSettings.autodeliveryApi)
  if (api) merged.autodeliveryApi = api
  const topupApi = mergeWorkApiBlock(itemSettings.autotopupApi, groupSettings.autotopupApi)
  if (topupApi) merged.autotopupApi = topupApi
  return merged
}

function workStageTextMessages(stage, s) {
  const field =
    stage === 'purchase' ? 'automessage' : stage === 'sent' ? 'postPurchaseAutomessage' : 'dealConfirmedAutomessage'
  const arr = s?.[field]?.messages
  return Array.isArray(arr) ? arr : []
}

function workImageEntriesForStage(items, stage) {
  return (Array.isArray(items) ? items : [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (row?.trigger ?? 'purchase') === stage)
}

/**
 * Порядок плиток текст/время/картинка для стадии, как его исполняет бэкенд
 * (resolveOrderedStageSteps): сохранённый autoPlacementOrder для существующих
 * t/w/i-ключей, затем недостающие в каноничном порядке.
 */
function workOrderedTwiKeys(stage, s) {
  const built = []
  workStageTextMessages(stage, s).forEach((_, i) => built.push(`t:${i}`))
  if (stage === 'purchase' && s?.purchaseWindowAutomessage?.enabled) built.push('w')
  workImageEntriesForStage(s?.imageAutomessage?.items, stage).forEach(({ index }) => built.push(`i:${index}`))
  const builtSet = new Set(built)
  const isTwi = (k) =>
    typeof k === 'string' && (k.startsWith('t:') || (k === 'w' && stage === 'purchase') || k.startsWith('i:'))
  const storedRaw = Array.isArray(s?.autoPlacementOrder?.[stage]) ? s.autoPlacementOrder[stage] : []
  const stored = storedRaw.filter((k) => isTwi(k) && builtSet.has(k))
  // Дедуп так же, как backend resolveOrderedStageSteps (dedupePlacementOrder),
  // иначе дублированный ключ в сохранённом порядке отрисовал бы шаг дважды.
  const seen = new Set()
  const merged = []
  for (const k of stored) {
    if (!seen.has(k)) {
      merged.push(k)
      seen.add(k)
    }
  }
  for (const k of built) {
    if (!seen.has(k)) {
      merged.push(k)
      seen.add(k)
    }
  }
  return merged
}

/** Шаги текст/время/картинка для стадии (с учётом фактической активности). */
function buildTwiSteps(stage, s, imageUrlBuilder) {
  const steps = []
  const texts = workStageTextMessages(stage, s)
  const items = Array.isArray(s?.imageAutomessage?.items) ? s.imageAutomessage.items : []
  const textCfg =
    stage === 'purchase' ? s?.automessage : stage === 'sent' ? s?.postPurchaseAutomessage : s?.dealConfirmedAutomessage
  const textEnabled = Boolean(textCfg?.enabled)
  const imgEnabled = Boolean(s?.imageAutomessage?.enabled)
  for (const key of workOrderedTwiKeys(stage, s)) {
    if (key.startsWith('t:')) {
      const idx = parseInt(key.slice(2), 10)
      const text = texts[idx] != null ? String(texts[idx]) : ''
      if (!text.trim()) continue
      steps.push({
        kind: 'text',
        label: 'Текст',
        text: text.trim(),
        active: textEnabled,
        inactiveReason: textEnabled ? '' : 'блок текстовых автосообщений выключен',
      })
    } else if (key === 'w') {
      const cfg = s?.purchaseWindowAutomessage || {}
      const text = String(cfg.message || '').trim()
      if (!text) continue
      const start = String(cfg.start || '').trim()
      const end = String(cfg.end || '').trim()
      // Бэкенд (isWithinPurchaseWindow) парсит границы как «ЧЧ:ММ» и при пустых/
      // некорректных границах НЕ отправляет — повторяем эту проверку, а не
      // подставляем фиктивное окно 00:00–23:59.
      const hm = /^\d{1,2}:\d{2}$/
      const boundsOk = hm.test(start) && hm.test(end) && start !== end
      const enabled = Boolean(cfg.enabled)
      let inactiveReason = ''
      if (!enabled) inactiveReason = 'блок «Время» выключен'
      else if (!boundsOk) inactiveReason = 'окно времени задано некорректно — сообщение не будет отправлено'
      steps.push({
        kind: 'time',
        label: 'Время',
        text,
        active: enabled && boundsOk,
        inactiveReason,
        note: boundsOk
          ? `Отправится, только если оплата пришла в окно ${start}–${end} (МСК)`
          : 'Окно времени не задано — сообщение не будет отправлено',
      })
    } else if (key.startsWith('i:')) {
      const idx = parseInt(key.slice(2), 10)
      const row = items[idx]
      const imageId = row && String(row.imageId || '').trim()
      const ext = row && String(row.ext || '').trim()
      if (!imageId || !ext) continue
      steps.push({
        kind: 'image',
        label: 'Картинка',
        imageUrl: row.url ? imageUrlBuilder(row.url) : '',
        filename: String(row.filename || ''),
        active: imgEnabled,
        inactiveReason: imgEnabled ? '' : 'блок картинок выключен',
      })
    }
  }
  return steps
}

/**
 * Главная функция: эффективные настройки → упорядоченный по стадиям список шагов,
 * отражающий реальное поведение бота. ctx = { supercellCategoryMatch, supercellModuleEnabled, supercellGameName }.
 */
function buildWorkLogic(s, ctx, imageUrlBuilder) {
  if (!s) return { resolved: false, stages: [] }

  // ----- СТАДИЯ «Покупка» -----
  const purchaseSteps = buildTwiSteps('purchase', s, imageUrlBuilder)

  const ad = s.autodelivery || {}
  if (ad.enabled) {
    const subtabName = String(s.tableBinding?.subtabName || s.tableBinding?.subtabId || '').trim()
    const hasBinding = Boolean(String(s.tableBinding?.subtabId || '').trim())
    const sub = []
    const msgOnPurchase = String(ad.messageOnPurchase || '').trim()
    if (msgOnPurchase) sub.push({ label: 'Сообщение при покупке', text: msgOnPurchase })
    sub.push({
      label: 'Код из таблицы',
      text: hasBinding
        ? `Следующий свободный код из «${subtabName}»`
        : 'нет привязки к таблице — код не будет отправлен',
    })
    purchaseSteps.push({
      kind: 'autodelivery',
      label: 'Автовыдача (таблица)',
      active: hasBinding,
      inactiveReason: hasBinding ? '' : 'не выбрана таблица с кодами',
      substeps: sub,
      autoComplete: Boolean(ad.autoCompleteDeal),
    })
  }

  const api = s.autodeliveryApi || {}
  if (api.enabled) {
    const sub = []
    const msgOnPurchase = String(api.messageOnPurchase || '').trim()
    if (msgOnPurchase) sub.push({ label: 'Сообщение при покупке', text: msgOnPurchase })
    const tmpl = String(api.deliveryMessage || '').trim() || '{delivery}'
    sub.push({ label: 'Выдача', text: tmpl })
    const svc = [String(api.serviceName || '').trim(), String(api.variantName || '').trim()]
      .filter(Boolean)
      .join(' · ')
    // Бэкенд (runApprouteAutodelivery) пропускает выдачу без serviceId, а если
    // variantRequired — то и без variantId. Повторяем это условие активности.
    const apiHasService = Boolean(String(api.serviceId ?? '').trim())
    const apiVariantOk = !(api.variantRequired && !String(api.variantId ?? '').trim())
    const apiActive = apiHasService && apiVariantOk
    let apiInactiveReason = ''
    if (!apiHasService) apiInactiveReason = 'не выбран сервис AppRoute — выдача не сработает'
    else if (!apiVariantOk) apiInactiveReason = 'не выбран вариант/номинал AppRoute — выдача не сработает'
    purchaseSteps.push({
      kind: 'autodeliveryApi',
      label: 'Автовыдача Api (AppRoute)',
      active: apiActive,
      inactiveReason: apiInactiveReason,
      detail: svc || null,
      substeps: sub,
      autoComplete: Boolean(api.autoCompleteDeal || ad.autoCompleteDeal),
    })
  }

  const sc = s.supercellAutoRequestCode || {}
  // Шаг Supercell показываем только для Supercell-товаров (как в /lot, где блок
  // доступен лишь для Supercell-категорий). Иначе для не-Supercell товара с
  // случайно включённым флагом показывался бы лишний шаг «Автозапрос кода
  // Supercell», а бот его всё равно не запустит (нет Supercell-категории).
  if (sc.enabled && ctx?.supercellCategoryMatch) {
    const categoryOk = Boolean(ctx?.supercellCategoryMatch)
    const moduleOk = Boolean(ctx?.supercellModuleEnabled)
    const active = categoryOk && moduleOk
    const sub = []
    const ev = s.emailValidation || {}
    if (ev.enabled) {
      const invalidMsg = String(ev.invalidEmailMessage || '').trim()
      sub.push({ label: 'Проверка почты', text: invalidMsg || '(сообщение о неверной почте не задано)' })
    }
    const reqMsg = (String(sc.requestCodeMessage || '').trim() || SUPERCELL_CODE_DEFAULT_MESSAGE).replace(
      /\$game_name/g,
      canonicalSupercellGameName(ctx?.supercellGameName) || 'игры'
    )
    sub.push({ label: 'Запрос кода', text: reqMsg })
    let inactiveReason = ''
    if (!categoryOk) {
      inactiveReason = 'категория не Supercell (Brawl Stars / Clash Royale / Clash of Clans) — флоу не запустится'
    } else if (!moduleOk) {
      inactiveReason = 'модуль Supercell выключен'
    }
    purchaseSteps.push({
      kind: 'supercell',
      label: 'Автозапрос кода Supercell',
      active,
      inactiveReason,
      waitsForBuyer: true,
      substeps: sub,
    })
  }

  const tu = s.autotopupApi || {}
  if (tu.enabled) {
    const sub = [
      { label: 'Запрос ID', text: String(tu.askIdMessage || '').trim() || TOPUP_DEFAULT_MESSAGES.askIdMessage },
      {
        label: 'Подтверждение',
        text: String(tu.confirmTemplate || '').trim() || TOPUP_DEFAULT_MESSAGES.confirmTemplate,
      },
      {
        label: 'Если ID неверный',
        text: String(tu.invalidIdMessage || '').trim() || TOPUP_DEFAULT_MESSAGES.invalidIdMessage,
      },
      { label: 'Успех', text: String(tu.successMessage || '').trim() || TOPUP_DEFAULT_MESSAGES.successMessage },
    ]
    const svc = [String(tu.serviceName || '').trim(), String(tu.variantName || '').trim()]
      .filter(Boolean)
      .join(' · ')
    // Бэкенд (runApprouteTopup → resolveDenominationId) определяет номинал по
    // цепочке denominationId → variantId → variantOrderServiceId → serviceId и
    // без него короткозамыкает в no_config. Повторяем это условие активности.
    const topupDenom =
      [tu.denominationId, tu.variantId, tu.variantOrderServiceId, tu.serviceId]
        .map((v) => (v != null ? String(v).trim() : ''))
        .find(Boolean) || ''
    const topupActive = Boolean(topupDenom)
    purchaseSteps.push({
      kind: 'topup',
      label: 'Автопополнение (AppRoute API)',
      active: topupActive,
      inactiveReason: topupActive ? '' : 'не выбран номинал/сервис AppRoute — пополнение не сработает',
      detail: svc || null,
      waitsForBuyer: true,
      substeps: sub,
      autoComplete: Boolean(tu.autoCompleteDeal || ad.autoCompleteDeal),
    })
  }

  // Автовыдача Clode (Claude): бот спрашивает Claude user ID, подтверждает и
  // активирует подписку CDK-кодом из привязанной таблицы. Бэкенд (runClodeRedeemFlow)
  // короткозамыкает в no_config без привязки к таблице — повторяем это в активности.
  const clode = s.autoclode || {}
  if (clode.enabled) {
    const hasBinding = Boolean(String(s.tableBinding?.subtabId || '').trim())
    const subtabName = String(s.tableBinding?.subtabName || s.tableBinding?.subtabId || '').trim()
    const tierLabel = CLODE_TIER_LABELS[String(clode.tier || 'pro')] || CLODE_TIER_LABELS.pro
    const sub = [
      { label: 'Запрос ID', text: String(clode.askIdMessage || '').trim() || CLODE_DEFAULT_MESSAGES.askIdMessage },
      {
        label: 'Подтверждение',
        text: String(clode.confirmTemplate || '').trim() || CLODE_DEFAULT_MESSAGES.confirmTemplate,
      },
      {
        label: 'CDK из таблицы',
        text: hasBinding
          ? `Следующий свободный код из «${subtabName}»`
          : 'нет привязки к таблице — код не будет выдан',
      },
      { label: 'Успех', text: String(clode.successMessage || '').trim() || CLODE_DEFAULT_MESSAGES.successMessage },
    ]
    purchaseSteps.push({
      kind: 'clode',
      label: 'Автовыдача Clode (Claude)',
      active: hasBinding,
      inactiveReason: hasBinding ? '' : 'не выбрана таблица с CDK-кодами — выдача не сработает',
      detail: tierLabel,
      waitsForBuyer: true,
      substeps: sub,
      autoComplete: Boolean(clode.autoCompleteDeal || ad.autoCompleteDeal),
    })
  }

  // Автовыдача GPT (ChatGPT): бот просит ChatGPT ID и/или ссылку на Google-док с
  // Access Token (по inputMode) и активирует карт-кодом (card_key) из привязанной
  // таблицы. Бэкенд (runGptRedeemFlow) тоже требует привязку к таблице.
  const gpt = s.autogpt || {}
  if (gpt.enabled) {
    const hasBinding = Boolean(String(s.tableBinding?.subtabId || '').trim())
    const subtabName = String(s.tableBinding?.subtabName || s.tableBinding?.subtabId || '').trim()
    const mode = ['link', 'id', 'auto'].includes(String(gpt.inputMode || '').toLowerCase())
      ? String(gpt.inputMode).toLowerCase()
      : 'link'
    const askText =
      mode === 'id'
        ? String(gpt.askIdMessage || '').trim() || GPT_DEFAULT_MESSAGES.askIdMessage
        : mode === 'auto'
          ? String(gpt.askAutoMessage || '').trim() || GPT_DEFAULT_MESSAGES.askAutoMessage
          : String(gpt.askLinkMessage || '').trim() || GPT_DEFAULT_MESSAGES.askLinkMessage
    const sub = [
      { label: 'Запрос данных', text: askText },
      {
        label: 'Карт-код из таблицы',
        text: hasBinding
          ? `Следующий свободный код из «${subtabName}»`
          : 'нет привязки к таблице — код не будет выдан',
      },
      { label: 'Успех', text: String(gpt.successMessage || '').trim() || GPT_DEFAULT_MESSAGES.successMessage },
    ]
    purchaseSteps.push({
      kind: 'gpt',
      label: 'Автовыдача GPT (ChatGPT)',
      active: hasBinding,
      inactiveReason: hasBinding ? '' : 'не выбрана таблица с карт-кодами — выдача не сработает',
      detail: GPT_INPUT_MODE_LABELS[mode],
      waitsForBuyer: true,
      substeps: sub,
      autoComplete: Boolean(gpt.autoCompleteDeal || ad.autoCompleteDeal),
    })
  }

  const anyAutoComplete = purchaseSteps.some((st) => st.autoComplete && st.active)

  const sentSteps = buildTwiSteps('sent', s, imageUrlBuilder)
  const confirmedSteps = buildTwiSteps('confirmed', s, imageUrlBuilder)

  const stages = [
    { key: 'purchase', label: 'Покупка товара', marker: '{{ITEM_PAID}}', steps: purchaseSteps },
    {
      key: 'sent',
      label: 'Отправка товара',
      marker: '{{ITEM_SENT}}',
      conditional: true,
      conditionNote: anyAutoComplete
        ? 'Сработает автоматически после автозавершения сделки.'
        : 'Сработает только после ручной отправки товара (автозавершение не включено).',
      steps: sentSteps,
    },
    { key: 'confirmed', label: 'Подтверждение товара', marker: '{{DEAL_CONFIRMED}}', steps: confirmedSteps },
  ]

  return { resolved: true, stages, anyAutoComplete, hasAnySteps: stages.some((st) => st.steps.length > 0) }
}

function renderReviewBadge(review, { variant = 'list' } = {}) {
  const reviewObj = review && typeof review === 'object' ? review : null
  const left = reviewObj?.left === true
  const ratingNum = Number(reviewObj?.rating)
  const hasRating = Number.isFinite(ratingNum) && ratingNum > 0
  const cls = 'chat-review-badge chat-review-badge--' + variant + (left ? ' chat-review-badge--left' : ' chat-review-badge--none')
  if (!left) {
    return (
      <span className={cls} title="Покупатель не оставил отзыв">
        Без отзыва
      </span>
    )
  }
  return (
    <span className={cls} title={hasRating ? `Отзыв: ${ratingNum} из 5` : 'Отзыв оставлен'}>
      <span aria-hidden="true">★</span>
      {hasRating ? ` ${ratingNum}` : ' Отзыв'}
    </span>
  )
}

/** Денежная сумма в рублях для блока финансов по сделке. */
function formatRub(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`
}

/** Карточка финансов по сделке (цена/себестоимость/поднятия/прибыль). */
function renderDealFinCard(deal, { showTitle = false } = {}) {
  const f = deal && deal.financials
  if (!f) return null
  const profitPositive = Number(f.profit) >= 0
  return (
    <div className="chat-deal-fin">
      {showTitle && (
        <div className="chat-deal-fin__title">
          {deal.itemTitle ||
            deal.itemCategory ||
            `Сделка #${String(deal.dealId || '').slice(0, 8)}`}
        </div>
      )}
      <div className="chat-deal-fin__rows">
        <span className="chat-deal-fin__cell">
          <span className="chat-deal-fin__label">Стоимость</span>
          <span className="chat-deal-fin__value">{formatRub(f.salePrice)}</span>
        </span>
        <span className="chat-deal-fin__cell">
          <span className="chat-deal-fin__label">Себестоимость</span>
          <span className="chat-deal-fin__value">{formatRub(f.cost)}</span>
        </span>
        <span className="chat-deal-fin__cell">
          <span className="chat-deal-fin__label">Поднятия</span>
          <span className="chat-deal-fin__value">{formatRub(f.bumpCost)}</span>
        </span>
        <span className="chat-deal-fin__cell">
          <span className="chat-deal-fin__label">Прибыль</span>
          <span
            className={
              'chat-deal-fin__value ' +
              (profitPositive ? 'chat-deal-fin__value--pos' : 'chat-deal-fin__value--neg')
            }
          >
            {formatRub(f.profit)}
          </span>
        </span>
      </div>
    </div>
  )
}

export function ChatTab({
  token,
  lots = [],
  loadingLots = false,
  moduleSupercellEnabled = false,
  isPageActive = true,
}) {
  const location = useLocation()
  const summarizeChatForLog = useCallback((chat) => ({
    id: chat?.id ?? null,
    dealId: chat?.dealId ?? null,
    itemId: chat?.itemId ?? null,
    buyerName: String(chat?.buyerName || '').trim() || null,
    category: String(chat?.category || '').trim() || null,
    itemTitle: String(chat?.itemTitle || '').trim() || null,
    status: String(chat?.status || '').trim() || null,
    unreadCount: typeof chat?.unreadCount === 'number' ? chat.unreadCount : null,
    isHidden: Boolean(chat?.isHidden),
  }), [])

  const [chats, setChats] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null })
  const [selectedChatId, setSelectedChatId] = useState(null)
  const [chatStateById, setChatStateById] = useState({})
  const [draftByChatId, setDraftByChatId] = useState({})
  const [chatFilter, setChatFilter] = useState('all') // 'all' | 'hide-completed' | 'only-fulfillment' | 'test'
  const [testProductKey, setTestProductKey] = useState('')
  const [testProductLabel, setTestProductLabel] = useState('')
  const [testMessages, setTestMessages] = useState([])
  const [testRunning, setTestRunning] = useState(false)
  const [testError, setTestError] = useState(null)
  const [testSessionId, setTestSessionId] = useState(null)
  const [testActiveDealId, setTestActiveDealId] = useState(null)
  const [testWaiting, setTestWaiting] = useState(null) // 'game_id' | 'confirm' | 'email' | null
  const [testDraft, setTestDraft] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [testEventLoading, setTestEventLoading] = useState(false)
  const [testDealActionModal, setTestDealActionModal] = useState({ open: false, kind: null })
  const [testDealActionState, setTestDealActionState] = useState({
    loading: false,
    error: null,
    candidates: [],
    selectedDealId: null,
  })
  const [categoryCommands, setCategoryCommands] = useState([]) // [{ category, commands }]
  const [loadingCommands, setLoadingCommands] = useState(false)
  const [requestCodeModal, setRequestCodeModal] = useState({ open: false, chatId: null })
  const [requestCodeState, setRequestCodeState] = useState({ loading: false, error: null })
  const [dealActionModal, setDealActionModal] = useState({ open: false, kind: null, chatId: null })
  const [dealActionState, setDealActionState] = useState({
    loading: false,
    error: null,
    candidates: [],
    selectedDealId: null,
  })
  const [approuteRescanState, setApprouteRescanState] = useState({
    loading: false,
    error: null,
    notice: null,
  })
  const [recheckState, setRecheckState] = useState({
    loading: false,
    error: null,
    notice: null,
  })
  const [productSettingsList, setProductSettingsList] = useState([])
  const [fullScanState, setFullScanState] = useState({ loading: false, status: null, error: null })
  const [fullScanTick, setFullScanTick] = useState(0)
  const [showChatExtraInfo, setShowChatExtraInfo] = useState(false)
  const [workLogicOpen, setWorkLogicOpen] = useState(false)
  const [isMobileChatLayout, setIsMobileChatLayout] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 900px)').matches
  })
  const [mobileChatView, setMobileChatView] = useState('list')
  // На мобильном детали карточки товара (финансы/почта) свёрнуты по умолчанию,
  // чтобы лента сообщений была крупнее и читаемее.
  const [mobileCardExpanded, setMobileCardExpanded] = useState(false)
  const CHAT_EMAIL_OVERRIDE_STORAGE_KEY = 'playerok-chat-supercell-email-overrides'
  const [manualEmailByChatId, setManualEmailByChatId] = useState(() => {
    try {
      const raw = localStorage.getItem(CHAT_EMAIL_OVERRIDE_STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  })
  const [emailDraftByChatId, setEmailDraftByChatId] = useState({})
  const listRef = useRef(null)
  const messagesRef = useRef(null)
  const stickToBottomRef = useRef(true)
  const loadingMoreRef = useRef(false)
  const chatStateByIdRef = useRef({})
  const selectedChatIdRef = useRef(null)
  const preloadQueueRef = useRef([])
  const preloadQueueRunningRef = useRef(false)
  const batchLoadInFlightRef = useRef(new Set())
  // Антизацикливание превью: если бэкенд несколько раз подряд вернул ПУСТО для
  // чата (мёртвая «пустышка» — превью в строке списка есть, а сообщений нет),
  // перестаём перезагружать его. Ключ — chatId, значение — { signature, attempts }.
  // signature = lastMessageId|lastMessageText; при новом сообщении в списке
  // сигнатура меняется и счётчик сбрасывается, чтобы попробовать снова.
  const emptyChatLoadTrackerRef = useRef(new Map())
  const chatListScrollAnchorRef = useRef(null)
  const initialLoadDoneRef = useRef(false)
  // Целевой чат диплинка из наблюдателя сделок (/chat/<chatId>): держим его, пока
  // не найдём в подгруженном списке (при необходимости догружаем страницы).
  const pendingDeepLinkChatIdRef = useRef(null)
  const visibleChatsRef = useRef([])
  const chatsRef = useRef([])
  // Последний message_id, по которому мы уже отметили чат прочитанным на бэкенде.
  const lastMarkedReadByChatRef = useRef({})

  const hasToken = Boolean(token)
  const normalizeBuyerName = (value) => String(value || '').trim()
  const isGenericBuyerName = (value) => {
    const normalized = normalizeBuyerName(value).toLowerCase()
    if (!normalized) return true
    return ['покупатель', 'buyer', 'customer', 'заказчик', 'user'].includes(normalized)
  }

  useEffect(() => {
    if (!token) {
      setProductSettingsList([])
      return
    }
    let cancelled = false
    loadProductSettingsList(token)
      .then((data) => {
        if (!cancelled) setProductSettingsList(data.list || [])
      })
      .catch(() => {
        if (!cancelled) setProductSettingsList([])
      })
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setFullScanState({ loading: false, status: null, error: null })
      return
    }
    let cancelled = false
    let timerId = null
    const poll = async () => {
      try {
        const data = await fetchChatDbFullScanStatus()
        if (cancelled) return
        setFullScanState((prev) => ({
          ...prev,
          status: data?.unavailable ? prev.status : data?.state || null,
          error: null,
        }))
      } catch (err) {
        if (cancelled) return
        setFullScanState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }))
      } finally {
        if (!cancelled) timerId = setTimeout(poll, 1000)
      }
    }
    poll()
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
    }
  }, [token])

  const fullScanInProgress = Number(fullScanState.status?.scan_in_progress || 0) === 1
  const fullScanDone = Number(fullScanState.status?.scan_progress_done || 0)
  const fullScanTotal = Number(fullScanState.status?.scan_progress_total || 0)
  const fullScanProgressPercent =
    fullScanTotal > 0 ? Math.max(0, Math.min(100, Math.round((fullScanDone / fullScanTotal) * 100))) : 0
  const fullScanStartedAt = Number(fullScanState.status?.full_scan_requested_at || 0)
  const fullScanUpdatedAt = Number(fullScanState.status?.updated_at || 0)
  const fullScanElapsedSec =
    fullScanInProgress && fullScanStartedAt > 0
      ? Math.max(0, Math.floor((Date.now() - fullScanStartedAt) / 1000))
      : 0
  const fullScanUpdateLagSec =
    fullScanInProgress && fullScanUpdatedAt > 0
      ? Math.max(0, Math.floor((Date.now() - fullScanUpdatedAt) / 1000))
      : 0
  const fullScanCurrentLabel = String(fullScanState.status?.scan_current_label || '').trim()
  const fullScanCurrentStep = String(fullScanState.status?.scan_step || '').trim()
  const fullScanLastError = String(fullScanState.status?.last_error || '').trim()
  const fullScanPhase = String(fullScanState.status?.scan_phase || '').trim()
  const fullScanPaused = Number(fullScanState.status?.scan_paused || 0) === 1
  const fullScanPhaseLabel =
    fullScanPhase === 'list'
      ? 'Сбор списка чатов'
      : fullScanPhase === 'history'
        ? 'Добор истории сообщений'
        : ''

  useEffect(() => {
    if (!fullScanInProgress) return
    const timer = setInterval(() => {
      setFullScanTick((v) => v + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [fullScanInProgress])

  const settingsByKey = useMemo(() => {
    const map = {}
    productSettingsList.forEach(({ productKey, settings }) => {
      if (productKey && settings) map[productKey] = settings
    })
    return map
  }, [productSettingsList])

  // Товары для тест-покупки: все активные лоты (как на вкладке «Активные»).
  const testProductOptions = useMemo(() => {
    const seen = new Set()
    const opts = []
    for (const lot of lots) {
      if (!lot) continue
      const key = getProductKey(lot)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const game = String(lot.game || '').trim()
      const title = String(lot.title || '').trim()
      const label = game ? `${game} — ${title}` : title || key
      opts.push({ value: key, label })
    }
    opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'))
    return opts
  }, [lots])

  const testSeqRef = useRef(0)
  const mapTestMsgs = useCallback((transcript) => {
    return (Array.isArray(transcript) ? transcript : []).map((m) => {
      const role =
        m && m.role === 'buyer'
          ? 'buyer'
          : m && m.role === 'seller'
            ? 'seller'
            : m && m.role === 'system'
              ? 'system'
              : 'bot'
      const imageUrlRaw = m && m.imageUrl != null ? String(m.imageUrl).trim() : ''
      const dealId = m && m.dealId != null ? String(m.dealId) : null
      return {
        id: `test-${testSeqRef.current++}`,
        role,
        text: m && m.text != null ? String(m.text) : '',
        imageUrl: imageUrlRaw ? automessageImageUrl(imageUrlRaw) : null,
        dealId,
      }
    })
  }, [])

  const runTestPurchase = useCallback(async () => {
    if (!token || !testProductKey || testRunning) return
    setTestRunning(true)
    setTestError(null)
    setTestDraft('')
    const label =
      testProductOptions.find((o) => o.value === testProductKey)?.label || testProductKey
    setTestProductLabel(label)
    try {
      const data = await testChatPurchase(token, {
        productKey: testProductKey,
        sessionId: testSessionId || undefined,
      })
      const chunk = mapTestMsgs(data?.transcript)
      setTestMessages((prev) => (data?.append ? [...prev, ...chunk] : chunk))
      setTestSessionId(data?.sessionId || null)
      setTestActiveDealId(data?.activeDealId || null)
      setTestWaiting(data?.waiting ?? null)
      if (data?.productLabel) setTestProductLabel(String(data.productLabel))
    } catch (err) {
      setTestError(err && err.message ? err.message : 'Ошибка тест-покупки')
    } finally {
      setTestRunning(false)
    }
  }, [token, testProductKey, testRunning, testSessionId, mapTestMsgs, testProductOptions])

  const sendTestMessage = useCallback(async () => {
    const text = testDraft.trim()
    if (!token || !testSessionId || !text || testSending) return
    const asRole = selectedChatId === TEST_CHAT_BUYER_ID ? 'buyer' : 'seller'
    setTestSending(true)
    setTestError(null)
    setTestDraft('')
    try {
      const data = await sendTestPurchaseMessage(token, { sessionId: testSessionId, text, asRole })
      setTestMessages((prev) => [...prev, ...mapTestMsgs(data?.transcript)])
      setTestWaiting(data?.waiting ?? null)
      if (data?.activeDealId) setTestActiveDealId(String(data.activeDealId))
      if (data?.productLabel) setTestProductLabel(String(data.productLabel))
    } catch (err) {
      setTestError(err && err.message ? err.message : 'Ошибка отправки сообщения')
      setTestDraft(text)
    } finally {
      setTestSending(false)
    }
  }, [token, testSessionId, testDraft, testSending, selectedChatId, mapTestMsgs])

  const runTestPurchaseEvent = useCallback(
    async (event, dealId) => {
      if (!token || !testSessionId || testEventLoading || !dealId) return
      setTestEventLoading(true)
      setTestError(null)
      try {
        const data = await sendTestPurchaseEvent(token, {
          sessionId: testSessionId,
          event,
          dealId,
        })
        setTestMessages((prev) => [...prev, ...mapTestMsgs(data?.transcript)])
        setTestWaiting(data?.waiting ?? null)
        if (data?.activeDealId) setTestActiveDealId(String(data.activeDealId))
        if (data?.productLabel) setTestProductLabel(String(data.productLabel))
      } catch (err) {
        setTestError(err && err.message ? err.message : 'Ошибка действия по сделке')
      } finally {
        setTestEventLoading(false)
      }
    },
    [token, testSessionId, testEventLoading, mapTestMsgs]
  )

  const closeTestDealActionModal = () => {
    setTestDealActionModal({ open: false, kind: null })
    setTestDealActionState({ loading: false, error: null, candidates: [], selectedDealId: null })
  }

  const openTestDealActionModal = useCallback(
    (kind) => {
      if (!token || !testSessionId || testEventLoading) return
      const all = buildTestDealsFromMessages(testMessages)
      const candidates =
        kind === 'item_sent'
          ? all.filter((d) => d.hasPaid && !d.hasSent)
          : all.filter((d) => d.hasSent && !d.hasConfirmed)
      if (candidates.length === 0) return
      if (candidates.length === 1) {
        void runTestPurchaseEvent(kind, candidates[0].dealId).catch(() => {})
        return
      }
      setTestDealActionState({
        loading: false,
        error: null,
        candidates,
        selectedDealId: null,
      })
      setTestDealActionModal({ open: true, kind })
    },
    [token, testSessionId, testEventLoading, testMessages, runTestPurchaseEvent]
  )

  const handleTestDealActionConfirm = async () => {
    const kind = testDealActionModal.kind
    if (!kind) return
    if (!testDealActionState.selectedDealId) {
      setTestDealActionState((prev) => ({
        ...prev,
        error: 'Выберите сделку, с которой выполнить действие.',
      }))
      return
    }
    setTestDealActionState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      await runTestPurchaseEvent(kind, testDealActionState.selectedDealId)
      closeTestDealActionModal()
    } catch {
      setTestDealActionState((prev) => ({ ...prev, loading: false }))
    }
  }

  // Эффективные настройки товара для чата = слияние групповой и индивидуальной
  // записей ровно как на бэкенде (mergeProductSettings). Для сгруппированного товара
  // (непустой settingsLabel) группа — база, а индивидуальные
  // autodeliveryApi/autotopupApi/autobump накладываются поверх. Так панель показывает
  // ровно то, что реально исполнит бот, а не только групповую запись.
  const resolveEffectiveSettingsForChat = useCallback(
    (chat, itemTitle) => {
      const title = String(itemTitle || chat?.itemTitle || '').trim()
      const game = String(chat?.category || '').trim()
      const key = getProductKey({ game, title })
      const item = settingsByKey[key]
      if (!item) return null
      const label = typeof item.settingsLabel === 'string' ? item.settingsLabel.trim() : ''
      if (!label) return item
      const group = settingsByKey[getGroupSettingsKey(label)]
      if (!group) return item
      return mergeWorkSettings(group, item)
    },
    [settingsByKey]
  )

  const DEFAULT_OUR_USERNAME = 'Levkaster'
  // Ник владельца токена приходит с бэкенда (getViewer); 'Levkaster' — запасной вариант.
  const [, setViewerUsername] = useState(null)
  const viewerUsernameRef = useRef(null)
  const getOurUsername = () => viewerUsernameRef.current || DEFAULT_OUR_USERNAME
  const noteViewerUsername = useCallback((value) => {
    const next = String(value || '').trim()
    if (!next || viewerUsernameRef.current === next) return
    viewerUsernameRef.current = next
    setViewerUsername(next)
  }, [])
  const isOwnUsername = (value) => {
    const v = String(value || '').trim().toLowerCase()
    if (!v) return false
    return v === getOurUsername().toLowerCase()
  }
  const SUPERCELL_EMAIL_GAMES = [
    'brawl stars',
    'clash royale',
    'clash of clans',
    'бравл старс',
    'бравл старк',
    'клеш рояль',
    'клеш оф кланс',
    'клеш оф кленс',
  ]
  const CHAT_CATEGORY_HINTS = [
    'YouTube',
    'Claude',
    'ChatGPT',
    'ЧатГПТ',
    'Brawl Stars',
    'Clash Royale',
    'Clash of Clans',
    'PUBG',
    'Call of Duty',
    'Discord',
    'Telegram',
  ]

  const SYSTEM_STATUS_BY_MARKER = useMemo(
    () => ({
      '{{ITEM_PAID}}': 'PAID',
      '{{ITEM_SENT}}': 'SENT',
      '{{DEAL_CONFIRMED}}': 'CONFIRMED',
      '{{DEAL_CONFIRMED_AUTOMATICALLY}}': 'CONFIRMED',
      '{{DEAL_ROLLED_BACK}}': 'ROLLED_BACK',
    }),
    []
  )
  const COMPLETED_MARKERS = useMemo(
    () => new Set(['{{DEAL_CONFIRMED}}', '{{DEAL_CONFIRMED_AUTOMATICALLY}}', '{{DEAL_ROLLED_BACK}}']),
    []
  )

  // Функция для преобразования hex цвета в RGB
  const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    return result
      ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
      : null
  }

  // Функция для определения яркости цвета (0-255)
  const getLuminance = (r, g, b) => {
    // Формула относительной яркости
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  // Функция для определения цвета текста на основе яркости фона
  const getTextColor = (backgroundColor) => {
    const rgb = hexToRgb(backgroundColor)
    if (!rgb) return '#fff'
    const luminance = getLuminance(rgb.r, rgb.g, rgb.b)
    // Если фон светлый (яркость > 128), используем темный текст, иначе светлый
    return luminance > 128 ? '#000' : '#fff'
  }

  const parseTimestamp = (value) => {
    const ts = Date.parse(value || '')
    return Number.isFinite(ts) ? ts : 0
  }

  const isFromBuyer = (message) => {
    if (typeof message?.fromBuyer === 'boolean') {
      return message.fromBuyer
    }
    if (message?._optimisticOutgoing === true) {
      return false
    }
    const username = (message?.user?.username || '').trim()
    if (!username) return true
    return !isOwnUsername(username)
  }

  const normalizeCategoryName = (name) =>
    String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/ё/g, 'е')

  const isSuperSellMarketplaceLabel = (name) => {
    const n = normalizeCategoryName(name)
    if (!n) return false
    const markers = [
      'super sell',
      'supersell',
      'super-sell',
      'суперселл',
      'супер селл',
      'супер-селл',
    ]
    return markers.some((m) => n === m || n.includes(m))
  }

  const SUPERCELL_TITLE_PATTERNS = [
    { re: /brawl\s*stars|brawlstars|бравл\s*стар/i, label: 'Brawl Stars' },
    { re: /clash\s*royale|clashroyale|клеш\s*роял|клеш\s*рояль/i, label: 'Clash Royale' },
    {
      re: /clash\s*of\s*clans|clashofclans|\bcoc\b|клеш\s*оф\s*клан|клеш\s*кланс|клеш\s*кленс/i,
      label: 'Clash of Clans',
    },
  ]

  const matchSupercellFromText = (text) => {
    const raw = String(text || '')
    if (!raw.trim()) return null
    for (const pattern of SUPERCELL_TITLE_PATTERNS) {
      if (pattern.re.test(raw)) return pattern.label
    }
    return null
  }

  const isSupercellCategory = (name) => {
    const n = normalizeCategoryName(name)
    if (!n) return false
    if (SUPERCELL_EMAIL_GAMES.includes(n)) return true
    if (SUPERCELL_EMAIL_GAMES.some((g) => n.includes(g))) return true
    if (isSuperSellMarketplaceLabel(name)) return true
    if (matchSupercellFromText(name)) return true
    return false
  }

  const chatSupportsSupercell = (chat, { itemTitle = '', deals = [] } = {}) => {
    if (!chat) return false
    const candidates = [
      chat.category,
      itemTitle,
      chat.itemTitle,
      ...(Array.isArray(deals) ? deals.map((d) => d.itemCategory) : []),
    ].filter((c) => c != null && String(c).trim())

    for (const c of candidates) {
      if (isSupercellCategory(c) && !isSuperSellMarketplaceLabel(c)) return true
    }
    for (const c of candidates) {
      if (isSuperSellMarketplaceLabel(c)) return true
    }
    for (const c of candidates) {
      const derived = deriveCategoryFromText(c)
      if (derived && isSupercellCategory(derived)) return true
    }
    if (matchSupercellFromText(itemTitle) || matchSupercellFromText(chat.itemTitle)) return true
    return false
  }

  const resolveSupercellCategoryForRequest = (chat, { itemTitle = '', deals = [] } = {}) => {
    if (!chat) return ''
    const candidates = [
      chat.category,
      itemTitle,
      chat.itemTitle,
      ...(Array.isArray(deals) ? deals.map((d) => d.itemCategory) : []),
    ].filter((c) => c != null && String(c).trim())

    for (const c of candidates) {
      if (isSupercellCategory(c) && !isSuperSellMarketplaceLabel(c)) return String(c).trim()
    }
    for (const c of candidates) {
      const derived = deriveCategoryFromText(c)
      if (derived && isSupercellCategory(derived) && !isSuperSellMarketplaceLabel(derived)) {
        return derived
      }
    }
    const fromTitle = matchSupercellFromText(itemTitle) || matchSupercellFromText(chat.itemTitle)
    if (fromTitle) return fromTitle
    for (const c of candidates) {
      if (isSupercellCategory(c)) return String(c).trim()
    }
    return ''
  }

  const deriveCategoryFromText = useCallback((value) => {
    const text = String(value || '').trim()
    if (!text) return null
    const lower = text.toLowerCase()
    for (const hint of CHAT_CATEGORY_HINTS) {
      if (lower.includes(hint.toLowerCase())) return hint
    }
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length === 0) return null
    return words.slice(0, 2).join(' ')
  }, [])

  const isEmailValid = (email) => {
    const value = String(email || '').trim()
    if (!value) return false
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  }

  const saveManualEmailsToStorage = (next) => {
    try {
      localStorage.setItem(CHAT_EMAIL_OVERRIDE_STORAGE_KEY, JSON.stringify(next))
    } catch (_e) {
      // quota or disabled
    }
  }

  const isSystemMessage = (text) => {
    if (!text || typeof text !== 'string') return false
    // Проверяем, содержит ли текст плейсхолдеры в формате {{...}}
    return /\{\{[A-Z_]+\}\}/.test(text)
  }

  const formatMessageText = (text) => {
    if (!text || typeof text !== 'string') return text

    // Словарь замены плейсхолдеров на понятные тексты
    const replacements = {
      '{{ITEM_PAID}}': 'Оплата покупки',
      '{{ITEM_SENT}}': 'Товар отправлен',
      '{{DEAL_CONFIRMED}}': 'Сделка подтверждена',
      '{{DEAL_CONFIRMED_AUTOMATICALLY}}': 'Сделка подтверждена автоматически',
      '{{DEAL_ROLLED_BACK}}': 'Сделка отменена',
    }

    let result = text

    // Заменяем известные плейсхолдеры
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), replacement)
    }

    // Универсальная замена для любых других плейсхолдеров в формате {{...}}
    result = result.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
      // Если уже обработано выше, пропускаем
      if (replacements[match]) return replacements[match]

      // Преобразуем ключ в понятный текст
      const readable = key
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (l) => l.toUpperCase())
      return readable
    })

    return result
  }

  const previewFromListRow = (chat) => {
    const fallbackText = String(chat.lastMessageText || '').trim()
    if (!fallbackText) return null
    const fromBuyer =
      typeof chat?.lastMessageFromBuyer === 'boolean'
        ? chat.lastMessageFromBuyer
        : !isSystemMessage(fallbackText)
    return {
      text: formatMessageText(fallbackText),
      fromBuyer,
    }
  }

  /** Последнее НЕ системное сообщение в чате + кто отправил. */
  const getLastChatMessagePreviewInfo = (chat) => {
    if (!chat?.id) return null
    const state = chatStateById[chat.id]
    const messages = Array.isArray(state?.messages) ? state.messages : []
    const listLastId = chat.lastMessageId != null ? String(chat.lastMessageId) : null

    let lastFromState = null
    let lastFromStateId = null
    let lastFromStateTs = 0

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (!m) continue

      // В превью списка не показываем системные сообщения.
      if (isSystemMessage(m.text)) continue

      if (m.imageUrl && !String(m.text || '').trim()) {
        lastFromStateId = m.id != null ? String(m.id) : null
        lastFromState = {
          text: 'Картинка',
          fromBuyer: isFromBuyer(m),
        }
        lastFromStateTs = parseTimestamp(m.createdAt)
        break
      }
      const t = String(m.text || '').trim()
      if (!t) continue
      lastFromStateId = m.id != null ? String(m.id) : null
      lastFromState = {
        text: formatMessageText(t),
        fromBuyer: isFromBuyer(m),
      }
      lastFromStateTs = parseTimestamp(m.createdAt)
      break
    }

    const listAheadOfLocal =
      Boolean(listLastId) &&
      (!lastFromStateId || listLastId !== lastFromStateId)

    const listTs = parseTimestamp(chat.lastMessageCreatedAt)
    const shouldUseListPreview =
      listAheadOfLocal &&
      (!lastFromState ||
        (listTs > 0 && lastFromStateTs > 0 ? listTs > lastFromStateTs : lastFromState.fromBuyer))

    if (shouldUseListPreview) {
      const fromList = previewFromListRow(chat)
      if (fromList) return fromList
    }

    if (lastFromState) return lastFromState
    return previewFromListRow(chat)
  }

  const getDerivedChatStatus = (chat) => {
    if (!chat) return ''
    const state = chatStateById[chat.id]
    const messages = Array.isArray(state?.messages) ? state.messages : []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const marker = String(messages[i]?.text || '').trim()
      const derivedStatus = SYSTEM_STATUS_BY_MARKER[marker]
      if (derivedStatus) return derivedStatus
    }
    const lastMarker = String(chat.lastMessageText || '').trim()
    if (SYSTEM_STATUS_BY_MARKER[lastMarker]) {
      return SYSTEM_STATUS_BY_MARKER[lastMarker]
    }
    return String(chat.status || '').toUpperCase()
  }

  // Статус только из стабильных полей строки списка (без загруженных сообщений),
  // чтобы членство в фильтрах не «прыгало», пока чаты подгружаются.
  const getStableChatStatus = (chat) => {
    if (!chat) return ''
    const lastMarker = String(chat.lastMessageText || '').trim()
    if (SYSTEM_STATUS_BY_MARKER[lastMarker]) {
      return SYSTEM_STATUS_BY_MARKER[lastMarker]
    }
    return String(chat.status || '').toUpperCase()
  }

  const extractBuyerNameFromMessages = (messages) => {
    if (!Array.isArray(messages) || messages.length === 0) return null
    for (const msg of messages) {
      const msgUser = msg.user
      if (msgUser && msgUser.username && !isOwnUsername(msgUser.username)) {
        return msgUser.username
      }
    }
    return null
  }

  const sortChatMessages = (messages) => {
    return [...(messages || [])].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return ta - tb
    })
  }

  /** Если thread/список опережает загруженные messages — показываем lastMessage из списка. */
  const mergeListAheadMessage = (chat, messages) => {
    if (!chat?.id) return Array.isArray(messages) ? messages : []
    const list = Array.isArray(messages) ? [...messages] : []
    const listLastId = chat.lastMessageId != null ? String(chat.lastMessageId) : null
    if (!listLastId || list.some((m) => m?.id != null && String(m.id) === listLastId)) {
      return list
    }
    const latestLoaded = list.length > 0 ? list[list.length - 1] : null
    if (latestLoaded) {
      const listTs = parseTimestamp(chat.lastMessageCreatedAt)
      const latestLoadedTs = parseTimestamp(latestLoaded.createdAt)
      if (listTs > 0 && latestLoadedTs > 0 && latestLoadedTs >= listTs) {
        return list
      }
      if (listTs <= 0 && !isFromBuyer(latestLoaded)) {
        return list
      }
    }
    const text = String(chat.lastMessageText || '').trim()
    if (!text) return list
    const fromBuyer =
      typeof chat?.lastMessageFromBuyer === 'boolean'
        ? chat.lastMessageFromBuyer
        : !isSystemMessage(text)
    logChatMessagesGap('ui:merge-list-ahead', {
      chatId: chat.id,
      listLastId,
      textPreview: text.slice(0, 120),
      loadedCount: list.length,
    })
    list.push({
      id: listLastId,
      text,
      createdAt: chat.lastMessageCreatedAt || null,
      imageUrl: null,
      user: {
        username: fromBuyer
          ? String(chat.buyerName || '').trim() || null
          : getOurUsername(),
      },
      _fromListPreview: true,
    })
    return sortChatMessages(list)
  }

  const isMessagesNearBottom = (el, threshold = 80) => {
    if (!el) return true
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    return distance < threshold
  }

  const scrollMessagesToBottom = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const applyLoadedChatData = (
    chat,
    list,
    itemTitle,
    itemImageUrl,
    buyerSupercellEmail,
    itemCategory = null,
    dealSummaries = null,
    review = null
  ) => {
    const chatId = chat.id
    const prevMessagesSnapshot = Array.isArray(chatStateByIdRef.current[chatId]?.messages)
      ? chatStateByIdRef.current[chatId].messages
      : []
    const knownUsernameByMessageId = new Map(
      prevMessagesSnapshot
        .map((m) => [m?.id != null ? String(m.id) : '', String(m?.user?.username || '').trim()])
        .filter(([id, username]) => Boolean(id) && Boolean(username))
    )
    const sortedMessages = sortChatMessages(list).map((message) => {
      const username = String(message?.user?.username || '').trim()
      if (username || message?.id == null) return message
      const knownUsername = knownUsernameByMessageId.get(String(message.id))
      if (!knownUsername) return message
      return {
        ...message,
        user: { ...(message.user || {}), username: knownUsername },
      }
    })
    const latestMessage =
      Array.isArray(sortedMessages) && sortedMessages.length > 0
        ? sortedMessages[sortedMessages.length - 1]
        : null
    const latestMessageId = latestMessage?.id != null ? String(latestMessage.id) : null
    const latestMessageText =
      latestMessage?.text != null ? String(latestMessage.text) : null
    const latestMessageCreatedAt = latestMessage?.createdAt || null
    const latestMessageFromBuyer =
      latestMessage && !isSystemMessage(latestMessageText) ? isFromBuyer(latestMessage) : null
    const extractedBuyerName = extractBuyerNameFromMessages(list)
    const shouldPatchBuyerName =
      !isGenericBuyerName(extractedBuyerName) &&
      isGenericBuyerName(chat.buyerName)
    const currentCategory = String(chat.category || '').trim()
    const shouldRecoverCategory =
      !currentCategory ||
      currentCategory === 'Категория не определена' ||
      isSuperSellMarketplaceLabel(currentCategory)
    const serverCategory =
      itemCategory && String(itemCategory).trim() ? String(itemCategory).trim() : null
    const recoveredCategory = shouldRecoverCategory
      ? deriveCategoryFromText(itemTitle || chat.itemTitle || '')
      : null
    const resolvedCategory = shouldRecoverCategory
      ? serverCategory || recoveredCategory || null
      : null

    if (shouldPatchBuyerName) {
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId ? { ...c, buyerName: extractedBuyerName } : c
        )
      )
    }
    if (resolvedCategory) {
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? {
                ...c,
                category: resolvedCategory,
                itemTitle: itemTitle || c.itemTitle || null,
              }
            : c
        )
      )
      logChatLogging(
        serverCategory ? 'category_from_deal_messages' : 'category_recovered_from_itemTitle',
        {
          chat: summarizeChatForLog(chat),
          resolvedCategory,
          itemTitle: itemTitle || chat.itemTitle || null,
        }
      )
    }

    // Обновляем превью чата слева только если локально пришли действительно
    // более свежие данные, чтобы не откатывать новый lastMessage из списка чатов.
    if (latestMessageId || latestMessageText || latestMessageCreatedAt) {
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c
          const currentTs = c.lastMessageCreatedAt ? Date.parse(c.lastMessageCreatedAt) : 0
          const loadedTs = latestMessageCreatedAt ? Date.parse(latestMessageCreatedAt) : 0
          const hasCurrentTs = Number.isFinite(currentTs) && currentTs > 0
          const hasLoadedTs = Number.isFinite(loadedTs) && loadedTs > 0
          const loadedIsNewer = hasLoadedTs && (!hasCurrentTs || loadedTs > currentTs)
          const canFillGaps =
            !hasCurrentTs &&
            (!c.lastMessageId || !String(c.lastMessageText || '').trim())

          if (!loadedIsNewer && !canFillGaps) return c

          const nextLastMessageId = latestMessageId || c.lastMessageId || null
          const nextLastMessageText = latestMessageText || c.lastMessageText || null
          const nextLastMessageCreatedAt = latestMessageCreatedAt || c.lastMessageCreatedAt || null
          const nextDealId =
            latestMessage?.dealId != null
              ? String(latestMessage.dealId)
              : c.dealId || null
          const nextLastMessageFromBuyer =
            typeof latestMessageFromBuyer === 'boolean'
              ? latestMessageFromBuyer
              : String(nextLastMessageId || '') === String(c.lastMessageId || '')
                ? (typeof c.lastMessageFromBuyer === 'boolean' ? c.lastMessageFromBuyer : null)
                : null

          if (
            String(nextLastMessageId || '') === String(c.lastMessageId || '') &&
            String(nextLastMessageText || '') === String(c.lastMessageText || '') &&
            String(nextLastMessageCreatedAt || '') === String(c.lastMessageCreatedAt || '') &&
            String(nextDealId || '') === String(c.dealId || '') &&
            (typeof nextLastMessageFromBuyer === 'boolean'
              ? nextLastMessageFromBuyer
              : null) ===
              (typeof c.lastMessageFromBuyer === 'boolean' ? c.lastMessageFromBuyer : null)
          ) {
            return c
          }

          return {
            ...c,
            lastMessageId: nextLastMessageId,
            lastMessageText: nextLastMessageText,
            lastMessageCreatedAt: nextLastMessageCreatedAt,
            dealId: nextDealId,
            lastMessageFromBuyer: nextLastMessageFromBuyer,
          }
        })
      )
    }

    setChatStateById((prev) => {
      const prevState = prev[chatId] || {}
      const prevMessages = Array.isArray(prevState.messages) ? prevState.messages : []
      // Не даём пустому/устаревшему ответу "снести" уже загруженную историю чата.
      let nextMessages =
        sortedMessages.length === 0 && prevMessages.length > 0
          ? prevMessages
          : sortedMessages
      const pendingLocalMessages = prevMessages.filter((m) => m?._optimisticOutgoing === true)
      if (pendingLocalMessages.length > 0) {
        const knownMessageIds = new Set(
          nextMessages
            .filter((m) => m?.id != null)
            .map((m) => String(m.id))
        )
        let hasAddedPending = false
        for (const pending of pendingLocalMessages) {
          const pendingId = pending?.id != null ? String(pending.id) : ''
          if (!pendingId || knownMessageIds.has(pendingId)) continue
          knownMessageIds.add(pendingId)
          nextMessages.push(pending)
          hasAddedPending = true
        }
        if (hasAddedPending) {
          nextMessages = sortChatMessages(nextMessages)
        }
      }
      const listLastId = chat.lastMessageId != null ? String(chat.lastMessageId) : null
      const apiHasListLast =
        Boolean(listLastId) &&
        nextMessages.some((m) => m?.id != null && String(m.id) === listLastId)
      if (listLastId && !apiHasListLast) {
        logChatMessagesGap('applyLoadedChatData:list-ahead-of-api', {
          chatId: chat.id,
          listLastId,
          apiCount: nextMessages.length,
          latestMessageId,
        })
      }
      nextMessages = mergeListAheadMessage(chat, nextMessages)
      const hasListLastInMessages =
        !listLastId || nextMessages.some((m) => m?.id != null && String(m.id) === listLastId)
      const expectsMessages = Boolean(
        chat.lastMessageId ||
        String(chat.lastMessageText || '').trim() ||
        latestMessageId
      )
      const loaded = !expectsMessages || hasListLastInMessages
      return {
        ...prev,
        [chatId]: {
          ...prevState,
          loading: false,
          error: null,
          messages: nextMessages,
          loaded,
          backgroundLoading: false,
          itemTitle: itemTitle || chat.itemTitle || prevState.itemTitle || null,
          itemImageUrl: prevState.itemImageUrl || chat.itemImageUrl || itemImageUrl || null,
          deals: Array.isArray(dealSummaries) ? dealSummaries : prevState.deals || [],
          buyerSupercellEmail: buyerSupercellEmail ?? prevState.buyerSupercellEmail ?? null,
          review: review != null ? review : (prevState.review != null ? prevState.review : null),
        },
      }
    })
    if (review != null) {
      setChats((prev) =>
        prev.map((c) => (c.id === chatId ? { ...c, review } : c))
      )
    }
    logChatLogging('applyLoadedChatData', {
      chat: summarizeChatForLog(chat),
      messagesCount: Array.isArray(list) ? list.length : 0,
      loadedItemTitle: itemTitle || null,
      loadedItemImageUrl: itemImageUrl || null,
      buyerSupercellEmail: buyerSupercellEmail || null,
      itemCategory: serverCategory || null,
    })
  }

  useEffect(() => {
    chatStateByIdRef.current = chatStateById
  }, [chatStateById])

  useEffect(() => {
    chatsRef.current = chats
  }, [chats])

  useEffect(() => {
    selectedChatIdRef.current = selectedChatId
  }, [selectedChatId])

  const pullMessagesForChat = useCallback(
    async (chat, { silent = false } = {}) => {
      if (!token || !chat?.id) return
      if (isTestChatId(chat.id)) return // тест-чат синтетический, истории на бэке нет
      const chatId = chat.id
      const isSelected = selectedChatIdRef.current === chatId
      const hasCachedMessages = Boolean(chatStateByIdRef.current[chatId]?.messages?.length)
      if (isSelected && !silent && !hasCachedMessages) {
        setChatStateById((prev) => ({
          ...prev,
          [chatId]: {
            ...(prev[chatId] || {}),
            loading: true,
            error: null,
            messages: prev[chatId]?.messages || [],
            loaded: false,
            backgroundLoading: false,
          },
        }))
      }
      try {
        const { list, buyerSupercellEmail, itemTitle, itemImageUrl, itemCategory, deals, viewerUsername, review } =
          await fetchChatDbMessages(token, {
            dealId: chat.dealId || null,
            chatId,
          })
        noteViewerUsername(viewerUsername)
        applyLoadedChatData(
          chat,
          list,
          itemTitle,
          itemImageUrl,
          buyerSupercellEmail || null,
          itemCategory,
          deals,
          review || null
        )
        // Вторая, фоновая фаза: если почта Supercell ИЛИ отзыв ещё не определены, дотягиваем
        // их полным запросом без skipSmartEmail. Раньше гейт был только !buyerSupercellEmail —
        // после бэкафилла почты у большинства Supercell-чатов почта известна, и полный запрос
        // НЕ срабатывал → отзыв никогда не дозагружался. Теперь триггерим и при отсутствии отзыва.
        // Не блокирует показ истории, идёт только для открытого чата.
        if (isSelected && (!buyerSupercellEmail || review == null)) {
          void fetchChatDbMessages(token, {
            dealId: chat.dealId || null,
            chatId,
            skipSmartEmail: false,
          })
            .then((enriched) => {
              if (selectedChatIdRef.current !== chatId) return
              if (!enriched) return
              const hasExtra =
                enriched.buyerSupercellEmail || enriched.review != null
              if (!hasExtra) return
              applyLoadedChatData(
                chat,
                Array.isArray(enriched.list) && enriched.list.length ? enriched.list : list,
                enriched.itemTitle || itemTitle,
                enriched.itemImageUrl || itemImageUrl,
                enriched.buyerSupercellEmail || null,
                enriched.itemCategory || itemCategory,
                Array.isArray(enriched.deals) && enriched.deals.length ? enriched.deals : deals,
                enriched.review != null ? enriched.review : review || null
              )
            })
            .catch(() => {})
        }
      } catch (_err) {
        if (isSelected && !silent && !hasCachedMessages) {
          const errMsg = _err instanceof Error ? _err.message : 'Ошибка загрузки чата'
          const rateLimited = isPlayerokRateLimitMessage(errMsg)
          setChatStateById((prev) => ({
            ...prev,
            [chatId]: {
              ...(prev[chatId] || {}),
              loading: false,
              error: errMsg,
              loaded: !rateLimited,
              backgroundLoading: false,
            },
          }))
        }
      }
    },
    [token]
  )

  const normalizeUnreadCount = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
    return Math.trunc(value)
  }

  const resolveUnreadCount = (prevChat, incomingChat, selectedChatIdForCalc) => {
    if (incomingChat?.id === selectedChatIdForCalc) {
      return 0
    }

    const incomingUnread = normalizeUnreadCount(incomingChat?.unreadCount)
    const incomingLastMessageFromBuyer =
      typeof incomingChat?.lastMessageFromBuyer === 'boolean'
        ? incomingChat.lastMessageFromBuyer
        : null
    if (incomingLastMessageFromBuyer === false) {
      return 0
    }
    const prevUnreadRaw = normalizeUnreadCount(prevChat?.unreadCount)
    const prevUnread = prevUnreadRaw != null ? prevUnreadRaw : 0
    const hasNewLastMessage =
      Boolean(prevChat && incomingChat) &&
      Boolean(incomingChat?.lastMessageId) &&
      String(prevChat?.lastMessageId || '') !== String(incomingChat.lastMessageId || '')

    if (incomingUnread != null) {
      return incomingUnread
    }

    if (hasNewLastMessage) {
      return prevUnread + 1
    }

    if (prevChat) {
      return prevUnread
    }

    return incomingUnread != null ? incomingUnread : 0
  }

  const saveChatListScrollAnchor = useCallback((mode = 'prepend') => {
    const el = listRef.current
    if (!el) return
    chatListScrollAnchorRef.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      mode,
    }
  }, [])

  const mergeChatEntry = useCallback((prevChat, incomingChat) => {
    const isPoorCategory = (value) => {
      const s = String(value || '').trim()
      return !s || s === 'Категория не определена'
    }
    if (!prevChat) {
      const incomingBuyer = normalizeBuyerName(incomingChat.buyerName)
      const incomingLastMessageFromBuyer =
        typeof incomingChat?.lastMessageFromBuyer === 'boolean'
          ? incomingChat.lastMessageFromBuyer
          : null
      return {
        ...incomingChat,
        buyerName: isGenericBuyerName(incomingBuyer) ? null : incomingBuyer,
        lastMessageFromBuyer: incomingLastMessageFromBuyer,
        review: incomingChat?.review != null ? incomingChat.review : null,
        hasOpenProblem: incomingChat?.hasOpenProblem === true,
        unreadCount: resolveUnreadCount(null, incomingChat, selectedChatIdRef.current),
      }
    }
    const incCat = String(incomingChat.category || '').trim()
    const prevCat = String(prevChat.category || '').trim()
    const incPoor = isPoorCategory(incCat)
    const prevPoor = isPoorCategory(prevCat)
    const mergedCategory = incPoor ? (prevPoor ? incCat : prevCat) : incCat
    const incomingBuyer = normalizeBuyerName(incomingChat.buyerName)
    const previousBuyer = normalizeBuyerName(prevChat.buyerName)
    const mergedBuyerName = isGenericBuyerName(incomingBuyer)
      ? (isGenericBuyerName(previousBuyer) ? incomingBuyer : previousBuyer)
      : incomingBuyer
    const incomingLastMessageFromBuyer =
      typeof incomingChat?.lastMessageFromBuyer === 'boolean'
        ? incomingChat.lastMessageFromBuyer
        : null
    const mergedLastMessageFromBuyer =
      incomingLastMessageFromBuyer != null
        ? incomingLastMessageFromBuyer
        : String(prevChat?.lastMessageId || '') === String(incomingChat?.lastMessageId || '')
          ? (typeof prevChat?.lastMessageFromBuyer === 'boolean' ? prevChat.lastMessageFromBuyer : null)
          : null
    return {
      ...prevChat,
      ...incomingChat,
      buyerName: mergedBuyerName || null,
      category: mergedCategory,
      itemImageUrl: prevChat.itemImageUrl || incomingChat.itemImageUrl || null,
      itemTitle: incomingChat.itemTitle || prevChat.itemTitle || null,
      lastMessageFromBuyer: mergedLastMessageFromBuyer,
      review: incomingChat?.review != null ? incomingChat.review : (prevChat?.review != null ? prevChat.review : null),
      hasOpenProblem:
        typeof incomingChat?.hasOpenProblem === 'boolean'
          ? incomingChat.hasOpenProblem
          : prevChat?.hasOpenProblem === true,
      unreadCount: resolveUnreadCount(prevChat, incomingChat, selectedChatIdRef.current),
    }
  }, [])

  const mergeChatsWithRefresh = useCallback((prevChats, incomingChats) => {
    const chatSortValue = (chat) => {
      const ts = chat?.lastMessageCreatedAt ? Date.parse(chat.lastMessageCreatedAt) : NaN
      return Number.isFinite(ts) ? ts : 0
    }
    const sortByLastMessageDesc = (list) =>
      [...(list || [])].sort((a, b) => {
        const aTs = chatSortValue(a)
        const bTs = chatSortValue(b)
        if (bTs !== aTs) return bTs - aTs
        return String(b?.id || '').localeCompare(String(a?.id || ''))
      })

    const prevById = new Map((prevChats || []).map((chat) => [chat.id, chat]))
    const incomingIds = new Set((incomingChats || []).map((chat) => chat.id))
    const refreshedHead = (incomingChats || []).map((incoming) =>
      mergeChatEntry(prevById.get(incoming.id) || null, incoming)
    )
    const tail = (prevChats || []).filter((chat) => !incomingIds.has(chat.id))
    return sortByLastMessageDesc([...refreshedHead, ...tail])
  }, [mergeChatEntry])

  const CHAT_MESSAGES_BATCH_SIZE = 6
  // Опрос реже: на слабом 1-CPU бэкенде частый опрос (1.2с) забивал event loop и
  // тормозил доставку кодов/автосообщений. 2.5–3с практически незаметны в UI, но
  // заметно снижают нагрузку. Конечная скорость обновления при этом выше — сервер
  // успевает отвечать.
  const CHAT_LIST_POLL_MS = 3000
  const CHAT_MESSAGES_POLL_MS = 2500
  const PRELOAD_INITIAL_COUNT = 8
  const PRELOAD_VIEWPORT_PRIORITY = 4
  // Сколько раз подряд терпим ПУСТОЙ ответ превью по одной и той же сигнатуре
  // строки списка, прежде чем перестать перезагружать «пустышку».
  const MAX_EMPTY_CHAT_LOAD_ATTEMPTS = 2

  const chatListSignature = (chat) =>
    `${chat?.lastMessageId != null ? String(chat.lastMessageId) : ''}|${String(chat?.lastMessageText || '').trim()}`

  // Превью этого чата уже вернулось пустым >= лимита раз для текущей сигнатуры —
  // дальше не дёргаем бэкенд, иначе мёртвая «пустышка» крутит бесконечный реквест.
  const emptyChatRetriesExhausted = (chat) => {
    if (!chat?.id) return false
    const rec = emptyChatLoadTrackerRef.current.get(String(chat.id))
    return Boolean(
      rec &&
        rec.signature === chatListSignature(chat) &&
        rec.attempts >= MAX_EMPTY_CHAT_LOAD_ATTEMPTS
    )
  }

  const chatNeedsMessagesLoad = useCallback((chatId) => {
    if (!chatId || isTestChatId(chatId)) return false
    const chatKey = String(chatId)
    if (batchLoadInFlightRef.current.has(chatKey)) return false
    const chat = chatsRef.current.find((c) => String(c.id) === chatKey)
    // «Пустышка» (превью есть, сообщений нет) уже исчерпала лимит попыток — стоп.
    if (chat && emptyChatRetriesExhausted(chat)) return false
    const state = chatStateByIdRef.current[chatId]
    if (state?.loaded && !state?.error) {
      if (!Array.isArray(state.messages) || state.messages.length === 0) {
        if (chat?.lastMessageId || String(chat?.lastMessageText || '').trim()) {
          return true
        }
      }
      return false
    }
    return true
  }, [])

  const loadChatsMessagesBatch = useCallback(async (targetChats, options = {}) => {
    if (!token || !Array.isArray(targetChats) || targetChats.length === 0) return
    const shouldCancel = typeof options.shouldCancel === 'function'
      ? options.shouldCancel
      : () => false
    const selectedId = selectedChatIdRef.current

    const chatsToLoad = targetChats.filter((chat) => chat?.id && chatNeedsMessagesLoad(chat.id))
    if (chatsToLoad.length === 0) return

    for (const chat of chatsToLoad) {
      batchLoadInFlightRef.current.add(String(chat.id))
    }

    const chatById = new Map(chatsToLoad.map((chat) => [String(chat.id), chat]))
    logChatLogging('loadChatsMessagesBatch:start', {
      targetChats: targetChats.length,
      chatsToLoad: chatsToLoad.length,
      chatIds: chatsToLoad.map((chat) => chat.id),
    })

    setChatStateById((prev) => {
      const next = { ...prev }
      for (const chat of chatsToLoad) {
        const chatId = chat.id
        const isSelected = chatId === selectedId
        const hasCachedMessages = Boolean(prev[chatId]?.messages?.length)
        next[chatId] = {
          ...(prev[chatId] || {}),
          loading: isSelected && !hasCachedMessages,
          error: null,
          messages: prev[chatId]?.messages || [],
          loaded: hasCachedMessages ? Boolean(prev[chatId]?.loaded) : false,
          backgroundLoading: !isSelected,
        }
      }
      return next
    })

    try {
      const entries = chatsToLoad.map((chat) => ({
        chatId: chat.id,
        dealId: chat.dealId || undefined,
        buyerName: chat.buyerName || undefined,
        category: chat.category || undefined,
      }))

      logChatLogging('loadChatsMessagesBatch:request', {
        count: entries.length,
        chatIds: entries.map((entry) => entry.chatId),
      })

      const { results } = await fetchChatDbMessagesBatch(token, entries)
      if (shouldCancel()) return

      for (const result of results) {
        const chatId = result?.chatId
        if (!chatId) continue
        const chat = chatById.get(String(chatId))
        if (!chat) continue

        if (!result.ok) {
          const errMsg = result.error || 'Ошибка загрузки чата'
          const rateLimited = isPlayerokRateLimitMessage(errMsg)
          logChatLogging('loadChatsMessagesBatch:item:error', {
            chat: summarizeChatForLog(chat),
            message: errMsg,
            rateLimited,
          })
          setChatStateById((prev) => ({
            ...prev,
            [chatId]: {
              ...(prev[chatId] || {}),
              loading: false,
              error: errMsg,
              messages: prev[chatId]?.messages || [],
              loaded: !rateLimited,
              backgroundLoading: false,
            },
          }))
          continue
        }

        // Учёт «пустышек»: пустой ответ по той же сигнатуре строки списка копит
        // счётчик (после лимита перестаём перезагружать), непустой — сбрасывает.
        const loadedListLen = Array.isArray(result.list) ? result.list.length : 0
        if (loadedListLen === 0) {
          const key = String(chatId)
          const signature = chatListSignature(chat)
          const prevRec = emptyChatLoadTrackerRef.current.get(key)
          const attempts = prevRec && prevRec.signature === signature ? prevRec.attempts + 1 : 1
          emptyChatLoadTrackerRef.current.set(key, { signature, attempts })
        } else {
          emptyChatLoadTrackerRef.current.delete(String(chatId))
        }

        noteViewerUsername(result.viewerUsername)
        applyLoadedChatData(
          chat,
          result.list,
          result.itemTitle,
          result.itemImageUrl,
          result.buyerSupercellEmail,
          result.itemCategory,
          result.deals,
          result.review || null
        )
      }

      logChatLogging('loadChatsMessagesBatch:chunk:done', {
        count: results.length,
        okCount: results.filter((item) => item.ok).length,
        errorCount: results.filter((item) => !item.ok).length,
      })
    } catch (err) {
      logChatLogging('loadChatsMessagesBatch:error', {
        message: err instanceof Error ? err.message : String(err),
        chatIds: chatsToLoad.map((chat) => chat.id),
      })
      if (shouldCancel()) return
      const errMsg = err instanceof Error ? err.message : 'Ошибка загрузки чата'
      const rateLimited = isPlayerokRateLimitMessage(errMsg)
      setChatStateById((prev) => {
        const next = { ...prev }
        for (const chat of chatsToLoad) {
          const chatId = chat.id
          next[chatId] = {
            ...(prev[chatId] || {}),
            loading: false,
            error: errMsg,
            messages: prev[chatId]?.messages || [],
            loaded: !rateLimited,
            backgroundLoading: false,
          }
        }
        return next
      })
    } finally {
      for (const chat of chatsToLoad) {
        batchLoadInFlightRef.current.delete(String(chat.id))
      }
      if (shouldCancel()) {
        setChatStateById((prev) => {
          const next = { ...prev }
          for (const chat of chatsToLoad) {
            const chatId = chat.id
            const prevState = prev[chatId]
            if (!prevState || prevState.loaded) continue
            next[chatId] = {
              ...prevState,
              loading: false,
              backgroundLoading: false,
            }
          }
          return next
        })
      }
    }
  }, [token, summarizeChatForLog, chatNeedsMessagesLoad])

  const drainPreloadQueue = useCallback(async () => {
    if (preloadQueueRunningRef.current) return
    preloadQueueRunningRef.current = true
    try {
      while (preloadQueueRef.current.length > 0) {
        if (!token) break
        const batch = preloadQueueRef.current.splice(0, CHAT_MESSAGES_BATCH_SIZE)
        const pending = batch.filter((chat) => chat?.id && chatNeedsMessagesLoad(chat.id))
        if (pending.length === 0) continue
        await loadChatsMessagesBatch(pending, { messagesOnly: true })
        // Небольшая пауза между батчами, чтобы преза­грузка не выдавала бэкенду
        // сплошной залп самых дорогих запросов и не вытесняла фоновую доставку.
        if (preloadQueueRef.current.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    } finally {
      preloadQueueRunningRef.current = false
      if (preloadQueueRef.current.length > 0) {
        void drainPreloadQueue()
      }
    }
  }, [token, loadChatsMessagesBatch, chatNeedsMessagesLoad])

  const enqueueChatsForPreload = useCallback(
    (targetChats, options = {}) => {
      if (!token || !Array.isArray(targetChats) || targetChats.length === 0) return
      const priority = options.priority === true
      const knownIds = new Set(preloadQueueRef.current.map((c) => c.id))
      const toAdd = []
      for (const chat of targetChats) {
        if (!chat?.id || knownIds.has(chat.id)) continue
        if (!chatNeedsMessagesLoad(chat.id)) continue
        knownIds.add(chat.id)
        toAdd.push(chat)
      }
      if (toAdd.length === 0) return
      if (priority) {
        preloadQueueRef.current.unshift(...toAdd)
      } else {
        preloadQueueRef.current.push(...toAdd)
      }
      void drainPreloadQueue()
    },
    [token, chatNeedsMessagesLoad, drainPreloadQueue]
  )

  const isChatCompleted = (chat) => {
    if (!chat) return false
    const status = getDerivedChatStatus(chat)
    if (status === 'CONFIRMED' || status === 'ROLLED_BACK') {
      return true
    }
    const state = chatStateById[chat.id]
    let lastText = null
    if (state && Array.isArray(state.messages) && state.messages.length > 0) {
      const last = state.messages[state.messages.length - 1]
      lastText = (last && last.text) || ''
    } else {
      lastText = chat.lastMessageText || ''
    }
    const trimmed = String(lastText || '').trim()
    return COMPLETED_MARKERS.has(trimmed)
  }

  // «Только выполнение»: статус PAID (Выполните заказ) либо есть открытая проблема по сделке.
  const isFulfillmentChat = (chat) => {
    if (!chat) return false
    if (getStableChatStatus(chat) === 'PAID') return true
    return chat.hasOpenProblem === true
  }

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const media = window.matchMedia('(max-width: 900px)')
    const onChange = (event) => {
      setIsMobileChatLayout(event.matches)
      if (!event.matches) {
        setMobileChatView('chat')
      }
    }
    setIsMobileChatLayout(media.matches)
    if (!media.matches) {
      setMobileChatView('chat')
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!isMobileChatLayout) return
    if (!selectedChatId) {
      setMobileChatView('list')
    }
  }, [isMobileChatLayout, selectedChatId])

  useEffect(() => {
    if (!token) {
      setChats([])
      setError(null)
      setPageInfo({ hasNextPage: false, endCursor: null })
      setSelectedChatId(null)
      setChatStateById({})
      setDraftByChatId({})
      initialLoadDoneRef.current = false
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        logChatLogging('fetchUserChats:start', { limit: 24 })
        const { list, pageInfo: info } = await fetchChatDbList(token, { limit: 24, offset: 0 })
        if (cancelled) return

        logChatLogging('fetchUserChats:success', {
          count: list.length,
          pageInfo: info || { hasNextPage: false, endCursor: null },
          undefinedCategoryCount: list.filter((c) => {
            const category = String(c?.category || '').trim()
            return !category || category === 'Категория не определена'
          }).length,
          sample: list.slice(0, 10).map(summarizeChatForLog),
        })
        setChats((prev) => {
          const prevById = new Map((prev || []).map((chat) => [chat.id, chat]))
          return (list || []).map((incomingChat) => {
            const prevChat = prevById.get(incomingChat.id) || null
            return mergeChatEntry(prevChat, incomingChat)
          }).sort((a, b) => {
            const aTs = a?.lastMessageCreatedAt ? Date.parse(a.lastMessageCreatedAt) : 0
            const bTs = b?.lastMessageCreatedAt ? Date.parse(b.lastMessageCreatedAt) : 0
            if (bTs !== aTs) return bTs - aTs
            return String(b?.id || '').localeCompare(String(a?.id || ''))
          })
        })
        setPageInfo(info || { hasNextPage: false, endCursor: null })
        initialLoadDoneRef.current = true
        if (list.length > 0) {
          const prevSelected = selectedChatIdRef.current
          let nextSelectedId =
            prevSelected && list.some((c) => c.id === prevSelected) ? prevSelected : null
          if (!nextSelectedId) {
            const firstVisible = list.find((c) =>
              chatFilter === 'hide-completed'
                ? !isChatCompleted(c)
                : chatFilter === 'only-fulfillment'
                  ? isFulfillmentChat(c)
                  : true
            )
            nextSelectedId = firstVisible ? firstVisible.id : null
          }
          selectedChatIdRef.current = nextSelectedId
          setSelectedChatId(nextSelectedId)
          void loadChatsMessagesBatch(list.slice(0, PRELOAD_INITIAL_COUNT))
        } else {
          selectedChatIdRef.current = null
          setSelectedChatId(null)
        }
      } catch (err) {
        if (cancelled) return
        logChatLogging('fetchUserChats:error', {
          message: err instanceof Error ? err.message : String(err),
        })
        setError(err instanceof Error ? err.message : 'Ошибка загрузки чатов')
        setChats([])
        setPageInfo({ hasNextPage: false, endCursor: null })
        setSelectedChatId(null)
        initialLoadDoneRef.current = false
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
      preloadQueueRef.current = []
      initialLoadDoneRef.current = false
    }
  }, [token, loadChatsMessagesBatch, mergeChatEntry, enqueueChatsForPreload])

  // Загрузка команд по категориям
  useEffect(() => {
    if (!token) {
      setCategoryCommands([])
      return
    }
    let cancelled = false
    setLoadingCommands(true)
    loadCategoryCommandsList(token)
      .then(({ list }) => {
        if (cancelled) return
        setCategoryCommands(list || [])
        setLoadingCommands(false)
      })
      .catch((err) => {
        if (cancelled) return
        setCategoryCommands([])
        setLoadingCommands(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const loadMore = useCallback(async () => {
    if (!token) {
      return
    }
    if (!pageInfo.hasNextPage) {
      return
    }
    if (loadingMoreRef.current) {
      return
    }

    // Используем endCursor, даже если он null или пустая строка
    // API должен обработать это корректно
    const afterCursor = pageInfo.endCursor || null
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      logChatLogging('loadMore:start', {
        requestParams: {
          limit: 24,
          afterCursor: pageInfo.endCursor || null,
        },
      })
      const requestParams = { limit: 24 }
      if (afterCursor) {
        requestParams.afterCursor = afterCursor
      }
      const { list, pageInfo: info } = await fetchChatDbList(token, {
        limit: requestParams.limit,
        offset: chatsRef.current.length,
      })

      if (!list || list.length === 0) {
        logChatLogging('loadMore:emptyPage', null)
        setPageInfo({ hasNextPage: false, endCursor: null })
        return
      }
      logChatLogging('loadMore:success', {
        count: list.length,
        pageInfo: info || { hasNextPage: false, endCursor: null },
        undefinedCategoryCount: list.filter((c) => {
          const category = String(c?.category || '').trim()
          return !category || category === 'Категория не определена'
        }).length,
        sample: list.slice(0, 10).map(summarizeChatForLog),
      })

      setChats((prev) => {
        const prevById = new Map(prev.map((chat) => [chat.id, chat]))
        const mergedNew = list.map((incoming) => mergeChatEntry(prevById.get(incoming.id) || null, incoming))
        return [...prev, ...mergedNew.filter((chat) => !prevById.has(chat.id))].sort((a, b) => {
          const aTs = a?.lastMessageCreatedAt ? Date.parse(a.lastMessageCreatedAt) : 0
          const bTs = b?.lastMessageCreatedAt ? Date.parse(b.lastMessageCreatedAt) : 0
          if (bTs !== aTs) return bTs - aTs
          return String(b?.id || '').localeCompare(String(a?.id || ''))
        })
      })

      const newPageInfo = info || { hasNextPage: false, endCursor: null }
      setPageInfo(newPageInfo)
      enqueueChatsForPreload(list)
    } catch (err) {
      logChatLogging('loadMore:error', {
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [token, pageInfo.hasNextPage, pageInfo.endCursor, mergeChatEntry, enqueueChatsForPreload])

  const visibleChats = useMemo(() => {
    if (chatFilter === 'test') {
      return [TEST_CHAT, TEST_CHAT_BUYER]
    }
    if (chatFilter === 'hide-completed') {
      const base = chats.filter((chat) => !chat.isHidden)
      return base.filter((chat) => !isChatCompleted(chat))
    }
    if (chatFilter === 'only-fulfillment') {
      const base = chats.filter((chat) => !chat.isHidden)
      return base.filter((chat) => isFulfillmentChat(chat))
    }
    return chats
  }, [chats, chatFilter, chatStateById])

  useEffect(() => {
    visibleChatsRef.current = visibleChats
  }, [visibleChats])

  const preloadChatsNearViewport = useCallback(() => {
    const el = listRef.current
    const chatList = visibleChatsRef.current
    if (!el || chatList.length === 0) return

    const elRect = el.getBoundingClientRect()
    const prefetchMargin = 200
    const nodes = el.querySelectorAll('.chat-list__item')
    const nearViewport = []

    nodes.forEach((node, index) => {
      if (index >= chatList.length) return
      const rect = node.getBoundingClientRect()
      if (
        rect.bottom >= elRect.top - prefetchMargin &&
        rect.top <= elRect.bottom + prefetchMargin
      ) {
        nearViewport.push(chatList[index])
      }
    })

    const slice = nearViewport.slice(0, PRELOAD_VIEWPORT_PRIORITY)
    if (slice.length > 0) {
      enqueueChatsForPreload(slice, { priority: true })
    }
  }, [enqueueChatsForPreload])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const handleScroll = () => {
      const scrollTop = el.scrollTop
      const scrollHeight = el.scrollHeight
      const clientHeight = el.clientHeight
      const distanceToBottom = scrollHeight - scrollTop - clientHeight
      const threshold = 80

      if (pageInfo.hasNextPage && !loadingMoreRef.current && distanceToBottom < threshold) {
        loadMore()
      }
      preloadChatsNearViewport()
    }
    el.addEventListener('scroll', handleScroll)
    return () => {
      el.removeEventListener('scroll', handleScroll)
    }
  }, [pageInfo.hasNextPage, pageInfo.endCursor, loadMore, preloadChatsNearViewport])

  useLayoutEffect(() => {
    const saved = chatListScrollAnchorRef.current
    chatListScrollAnchorRef.current = null
    if (!saved) return
    const el = listRef.current
    if (!el) return
    if (saved.mode === 'prepend') {
      const heightDelta = el.scrollHeight - saved.scrollHeight
      if (heightDelta > 0) {
        el.scrollTop = saved.scrollTop + heightDelta
      }
    } else {
      el.scrollTop = saved.scrollTop
    }
  }, [chats, visibleChats])

  useEffect(() => {
    if (!token || !initialLoadDoneRef.current || loading || loadingMore) return
    enqueueChatsForPreload(visibleChats.slice(0, PRELOAD_INITIAL_COUNT))
    preloadChatsNearViewport()
  }, [
    token,
    loading,
    loadingMore,
    visibleChats,
    enqueueChatsForPreload,
    preloadChatsNearViewport,
    PRELOAD_INITIAL_COUNT,
  ])

  useEffect(() => {
    // Пока ждём догрузки целевого чата диплинка — не перебиваем выбор дефолтным.
    if (pendingDeepLinkChatIdRef.current) return
    if (!selectedChatId && visibleChats.length > 0) {
      setSelectedChatId(visibleChats[0].id)
      return
    }
    if (selectedChatId && !visibleChats.some((c) => c.id === selectedChatId)) {
      setSelectedChatId(visibleChats.length > 0 ? visibleChats[0].id : null)
    }
  }, [chatFilter, visibleChats, selectedChatId])

  // Диплинк из наблюдателя сделок: URL /chat/<chatId> открывает конкретный чат.
  // location.key меняется на каждую навигацию, поэтому повторный клик по той же
  // сделке тоже сработает.
  useEffect(() => {
    const parts = (location.pathname || '').split('/').filter(Boolean)
    if (parts[0] !== 'chat' || !parts[1]) return
    let chatId = parts[1]
    try {
      chatId = decodeURIComponent(chatId)
    } catch (_) {
      // оставляем как есть
    }
    if (!chatId) return
    pendingDeepLinkChatIdRef.current = chatId
    setChatFilter('all') // чтобы целевой чат не был скрыт фильтром
    setSelectedChatId(chatId)
  }, [location.pathname, location.key])

  // Если целевой чат диплинка ещё не в подгруженном списке — догружаем страницы,
  // пока не найдём (или пока страницы не кончатся).
  useEffect(() => {
    const target = pendingDeepLinkChatIdRef.current
    if (!target) return
    if (chats.some((c) => String(c.id) === String(target))) {
      pendingDeepLinkChatIdRef.current = null
      if (selectedChatIdRef.current !== target) setSelectedChatId(target)
      return
    }
    if (!initialLoadDoneRef.current || loading || loadingMore) return
    if (pageInfo.hasNextPage) {
      loadMore()
    } else {
      // Чата нет ни на одной странице — снимаем запрос, выбор вернётся к дефолтному.
      pendingDeepLinkChatIdRef.current = null
    }
  }, [chats, pageInfo.hasNextPage, loading, loadingMore, loadMore])

  const isListAheadOfLoadedMessages = (chat) => {
    if (!chat?.id) return false
    const listLastId = chat.lastMessageId != null ? String(chat.lastMessageId) : null
    if (!listLastId) return false
    const messages = chatStateById[chat.id]?.messages
    if (!Array.isArray(messages) || messages.length === 0) return true
    return !messages.some((m) => m?.id != null && String(m.id) === listLastId)
  }

  const loadMessagesForChat = async (chat, { force = false } = {}) => {
    if (!token || !chat?.id) return
    if (isTestChatId(chat.id)) return // тест-чат синтетический, истории на бэке нет
    const state = chatStateByIdRef.current[chat.id]
    const hasCachedMessages = Boolean(state?.messages?.length)
    const listAhead = isListAheadOfLoadedMessages(chat)
    if (!force && state?.loaded && !state?.error && !listAhead) return
    if (!force && state?.error && !isPlayerokRateLimitMessage(state.error) && !listAhead) {
      return
    }
    await pullMessagesForChat(chat, { silent: hasCachedMessages && !listAhead })
  }

  const markChatAsRead = useCallback((chatId) => {
    if (!chatId || isTestChatId(chatId)) return
    // Оптимистично гасим бейдж локально...
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId && Number(chat.unreadCount || 0) > 0
          ? { ...chat, unreadCount: 0 }
          : chat
      )
    )
    // ...и сохраняем метку прочтения на бэкенде, чтобы непрочитанность не вернулась
    // после перезагрузки/следующего опроса (читаем мы только на своём сайте).
    if (token) {
      void markChatDbRead(token, chatId).catch(() => {})
    }
  }, [token])

  useEffect(() => {
    if (!selectedChatId) return
    setChatStateById((prev) => {
      const cur = prev[selectedChatId]
      if (cur?.messages?.length > 0) return prev
      if (cur?.loading) return prev
      return {
        ...prev,
        [selectedChatId]: {
          ...(cur || {}),
          loading: true,
          error: null,
          messages: cur?.messages || [],
          loaded: false,
          backgroundLoading: false,
        },
      }
    })
  }, [selectedChatId])

  useEffect(() => {
    if (!token || !selectedChatId) return
    const chat = chats.find((c) => c.id === selectedChatId)
    if (!chat) return
    loadMessagesForChat(chat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedChatId])

  const formatTime = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const isTestChat = isTestChatId(selectedChatId)
  const isBuyerView = selectedChatId === TEST_CHAT_BUYER_ID
  const testChatActive = Boolean(testSessionId && testMessages.length > 0)
  const testDealsForItemSent = useMemo(
    () => buildTestDealsFromMessages(testMessages).filter((d) => d.hasPaid && !d.hasSent),
    [testMessages]
  )
  const testDealsForConfirm = useMemo(
    () => buildTestDealsFromMessages(testMessages).filter((d) => d.hasSent && !d.hasConfirmed),
    [testMessages]
  )
  const testInputHint =
    testWaiting === 'game_id'
      ? 'Введите игровой ID/логин покупателя'
      : testWaiting === 'confirm'
        ? 'Напишите «да» для подтверждения (или «нет»)'
        : testWaiting === 'email'
          ? 'Введите почту покупателя'
          : 'Сообщение от покупателя…'
  const selectedChat = isTestChat
    ? (isBuyerView ? TEST_CHAT_BUYER : TEST_CHAT)
    : chats.find((c) => c.id === selectedChatId) || null
  const selectedChatState = selectedChat
    ? chatStateById[selectedChat.id] || {
        loading: Boolean(selectedChat.lastMessageId || String(selectedChat.lastMessageText || '').trim()),
        error: null,
        messages: [],
        loaded: false,
      }
    : null
  const selectedChatHasPreviewMessage = Boolean(
    selectedChat?.lastMessageId || String(selectedChat?.lastMessageText || '').trim()
  )
  const selectedChatMessagesPending =
    (selectedChatState?.messages || []).length === 0 &&
    (Boolean(selectedChatState?.loading || selectedChatState?.backgroundLoading) ||
      (!selectedChatState?.loaded &&
        selectedChatHasPreviewMessage))
  const selectedChatDeals = Array.isArray(selectedChatState?.deals) ? selectedChatState.deals : []
  // Текущая (последняя по ленте) сделка — её финансы показываем в шапке,
  // финансы предыдущих сделок показываем инлайн в ленте у начала каждой сделки.
  const selectedChatPrimaryDealId = (() => {
    const msgs = selectedChatState?.messages || []
    let last = null
    for (const m of msgs) {
      if (m && m.dealId) last = String(m.dealId)
    }
    if (last) return last
    if (selectedChat?.dealId) return String(selectedChat.dealId)
    return selectedChatDeals[0]?.dealId ? String(selectedChatDeals[0].dealId) : null
  })()
  const selectedChatDetectedEmail = String(selectedChatState?.buyerSupercellEmail || '').trim()
  const selectedChatManualEmail = selectedChat
    ? String(manualEmailByChatId[selectedChat.id] || '').trim()
    : ''
  const selectedChatEmail = selectedChatManualEmail || selectedChatDetectedEmail
  const selectedChatEmailDraft = selectedChat
    ? Object.prototype.hasOwnProperty.call(emailDraftByChatId, selectedChat.id)
      ? emailDraftByChatId[selectedChat.id]
      : selectedChatEmail
    : ''
  const selectedChatEmailIsValid = isEmailValid(selectedChatEmail)
  const selectedChatEmailDraftIsValid = isEmailValid(selectedChatEmailDraft)
  const currentItemImageUrl =
    selectedChat && (selectedChatState?.itemImageUrl || selectedChat.itemImageUrl || null)
  const currentItemTitle =
    selectedChat && (selectedChatState?.itemTitle || selectedChat.itemTitle || '')
  const selectedChatIsSupercell = chatSupportsSupercell(selectedChat, {
    itemTitle: currentItemTitle,
    deals: selectedChatDeals,
  })
  const selectedChatCanUseSupercell = selectedChatIsSupercell && moduleSupercellEnabled
  const selectedChatSupercellCategory = resolveSupercellCategoryForRequest(selectedChat, {
    itemTitle: currentItemTitle,
    deals: selectedChatDeals,
  })

  const selectedChatEffectiveSettings = useMemo(
    () => (selectedChat ? resolveEffectiveSettingsForChat(selectedChat, currentItemTitle) : null),
    [selectedChat, currentItemTitle, resolveEffectiveSettingsForChat]
  )

  const selectedChatApprouteEnabled = Boolean(selectedChatEffectiveSettings?.autodeliveryApi?.enabled)

  const selectedChatWorkLogic = useMemo(
    () =>
      buildWorkLogic(
        selectedChatEffectiveSettings,
        {
          supercellCategoryMatch: selectedChatIsSupercell,
          supercellModuleEnabled: moduleSupercellEnabled,
          supercellGameName: selectedChatSupercellCategory,
        },
        automessageImageUrl
      ),
    [selectedChatEffectiveSettings, selectedChatIsSupercell, moduleSupercellEnabled, selectedChatSupercellCategory]
  )

  useEffect(() => {
    setApprouteRescanState({ loading: false, error: null, notice: null })
    setRecheckState({ loading: false, error: null, notice: null })
    setShowChatExtraInfo(false)
    setWorkLogicOpen(false)
  }, [selectedChatId])

  useLayoutEffect(() => {
    stickToBottomRef.current = true
    scrollMessagesToBottom()
  }, [selectedChatId, scrollMessagesToBottom])

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return undefined
    const onScroll = () => {
      stickToBottomRef.current = isMessagesNearBottom(el)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [selectedChatId, selectedChatState?.messages?.length])

  useLayoutEffect(() => {
    if (!selectedChatId) return
    const state = chatStateById[selectedChatId]
    if (!state || state.loading) return
    if (!(state.messages?.length > 0)) return
    if (!stickToBottomRef.current) return
    scrollMessagesToBottom()
  }, [
    selectedChatId,
    selectedChatState?.loading,
    selectedChatState?.messages,
    scrollMessagesToBottom,
  ])

  useEffect(() => {
    if (!token || !selectedChat?.id || !isPageActive) return
    let cancelled = false
    let timerId = null
    let errorStreak = 0

    const scheduleNext = (delayMs) => {
      if (cancelled) return
      if (timerId) clearTimeout(timerId)
      timerId = setTimeout(() => {
        void refreshSelectedChat()
      }, delayMs)
    }

    const refreshSelectedChat = async () => {
      if (cancelled) return
      const chatId = selectedChatIdRef.current
      const chat = chatId ? chatsRef.current.find((c) => c.id === chatId) : null
      if (!chat) {
        scheduleNext(pollDelayAfterErrors(CHAT_MESSAGES_POLL_MS, errorStreak))
        return
      }
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleNext(pollDelayAfterErrors(CHAT_MESSAGES_POLL_MS, errorStreak))
        return
      }
      try {
        const { list, buyerSupercellEmail, itemTitle, itemImageUrl, itemCategory, deals, viewerUsername, review } =
          await fetchChatDbMessages(token, {
            dealId: chat.dealId || null,
            chatId: chat.id,
          })
        if (cancelled) return
        errorStreak = 0
        noteViewerUsername(viewerUsername)
        applyLoadedChatData(
          chat,
          list,
          itemTitle,
          itemImageUrl,
          buyerSupercellEmail || null,
          itemCategory,
          deals,
          review || null
        )
        // Чат открыт у нас на экране — двигаем метку прочтения на бэкенде, чтобы
        // сообщения, пришедшие во время просмотра, не вернулись «новыми» после выхода.
        const latestId =
          Array.isArray(list) && list.length > 0 && list[list.length - 1]?.id != null
            ? String(list[list.length - 1].id)
            : ''
        if (latestId && lastMarkedReadByChatRef.current[chat.id] !== latestId) {
          lastMarkedReadByChatRef.current[chat.id] = latestId
          if (token) void markChatDbRead(token, chat.id).catch(() => {})
        }
      } catch (err) {
        if (cancelled) return
        if (isPlayerokRateLimitMessage(err instanceof Error ? err.message : String(err))) {
          errorStreak += 1
        }
      } finally {
        if (!cancelled) {
          scheduleNext(pollDelayAfterErrors(CHAT_MESSAGES_POLL_MS, errorStreak))
        }
      }
    }

    scheduleNext(CHAT_MESSAGES_POLL_MS)
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isPageActive, selectedChat?.id, selectedChat?.dealId])

  useEffect(() => {
    if (!token || !isPageActive) return
    let cancelled = false
    let timerId = null
    let errorStreak = 0

    const scheduleNext = (delayMs) => {
      if (cancelled) return
      if (timerId) clearTimeout(timerId)
      timerId = setTimeout(() => {
        void refreshChatsList()
      }, delayMs)
    }

    const refreshChatsList = async () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleNext(pollDelayAfterErrors(CHAT_LIST_POLL_MS, errorStreak))
        return
      }
      try {
        const selectedId = selectedChatIdRef.current
        const prevSelected = selectedId
          ? chatsRef.current.find((c) => c.id === selectedId)
          : null

        const { list } = await fetchChatDbList(token, { limit: 24, offset: 0 })
        if (cancelled) return

        const nextSelected = selectedId ? list.find((c) => c.id === selectedId) : null
        const selectedHasNewListMessage =
          Boolean(nextSelected?.lastMessageId) &&
          String(prevSelected?.lastMessageId || '') !== String(nextSelected.lastMessageId)

        saveChatListScrollAnchor('prepend')
        setChats((prev) => mergeChatsWithRefresh(prev, list))
        errorStreak = 0
        enqueueChatsForPreload(list)
        requestAnimationFrame(() => preloadChatsNearViewport())

        if (selectedHasNewListMessage && nextSelected) {
          void pullMessagesForChat(nextSelected)
        }
      } catch (err) {
        if (cancelled) return
        if (isPlayerokRateLimitMessage(err instanceof Error ? err.message : String(err))) {
          errorStreak += 1
        }
      } finally {
        if (!cancelled) {
          scheduleNext(pollDelayAfterErrors(CHAT_LIST_POLL_MS, errorStreak))
        }
      }
    }

    scheduleNext(CHAT_LIST_POLL_MS)
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
    }
  }, [
    token,
    isPageActive,
    mergeChatsWithRefresh,
    saveChatListScrollAnchor,
    enqueueChatsForPreload,
    preloadChatsNearViewport,
    pullMessagesForChat,
  ])

  // Получаем команды для категории выбранного чата
  const currentCategoryCommands = useMemo(() => {
    if (!selectedChat) return []
    const category = (selectedChat.category || '').trim()
    if (!category) return []
    const categoryData = categoryCommands.find((c) => c.category === category)
    if (!categoryData || !Array.isArray(categoryData.commands)) return []
    return categoryData.commands
      .filter((cmd) => cmd.label && cmd.text)
      .map((cmd) => ({
        ...cmd,
        color: cmd.color || '#6c757d', // цвет по умолчанию, если не указан
      }))
  }, [selectedChat, categoryCommands])

  useEffect(() => {
    logChatLogging('chat-state-snapshot', {
      chatsCount: chats.length,
      visibleChatsCount: visibleChats.length,
      selectedChatId,
      selectedChat: selectedChat ? summarizeChatForLog(selectedChat) : null,
      emptyOrUndefinedCategories: chats
        .filter((chat) => {
          const category = String(chat?.category || '').trim()
          return !category || category === 'Категория не определена'
        })
        .map(summarizeChatForLog)
        .slice(0, 30),
    })
  }, [chats, visibleChats, selectedChatId, selectedChat, summarizeChatForLog])

  useEffect(() => {
    if (!selectedChat || !moduleSupercellEnabled) return
    const category = String(selectedChat.category || '').trim()
    logChatLogging('supercell:selectedChat', {
      chat: summarizeChatForLog(selectedChat),
      isSupercellCategory: isSupercellCategory(category),
      isSuperSellWrapper: isSuperSellMarketplaceLabel(category),
      detectedEmail: selectedChatDetectedEmail || null,
      manualEmail: selectedChatManualEmail || null,
      itemTitle: currentItemTitle || null,
      resolvedCategory: selectedChatSupercellCategory || null,
      canUseSupercell: selectedChatCanUseSupercell,
      moduleSupercellEnabled,
    })
  }, [
    selectedChat,
    moduleSupercellEnabled,
    selectedChatDetectedEmail,
    selectedChatManualEmail,
    currentItemTitle,
    selectedChatCanUseSupercell,
    summarizeChatForLog,
  ])

  const getOrderStatusLabel = (status) => {
    const s = String(status || '').toUpperCase()
    if (!s) return ''
    if (s === 'PAID') return 'Выполните заказ'
    if (s === 'SENT') return 'Ожидает подтверждения'
    if (s === 'CONFIRMED') return 'Подтверждено'
    if (s === 'ROLLED_BACK') return 'Возврат'
    if (s === 'PENDING') return 'Ожидание'
    return s.replace(/_/g, ' ')
  }

  const getStatusIcon = (status) => {
    const s = String(status || '').toUpperCase()
    if (!s) return { icon: '—', label: '—', tone: 'muted' }
    if (s === 'PAID') return { icon: '🛠️', label: 'Выполните заказ', tone: 'work' }
    if (s === 'SENT') return { icon: '⏳', label: 'Ожидает подтверждения', tone: 'sent' }
    if (s === 'CONFIRMED') return { icon: '✓', label: 'Подтверждено', tone: 'success' }
    if (s === 'ROLLED_BACK') return { icon: '↩', label: 'Возврат', tone: 'rollback' }
    if (s === 'PENDING') return { icon: '⏳', label: 'Ожидание', tone: 'sent' }
    return { icon: '•', label: s, tone: 'muted' }
  }

  const sortChatsByLastMessageDesc = (list) =>
    [...(list || [])].sort((a, b) => {
      const aTs = parseTimestamp(a?.lastMessageCreatedAt)
      const bTs = parseTimestamp(b?.lastMessageCreatedAt)
      if (bTs !== aTs) return bTs - aTs
      return String(b?.id || '').localeCompare(String(a?.id || ''))
    })

  const appendLocalMessageForChat = (chat, text, options = {}) => {
    if (!chat?.id) return
    const trimmed = String(text || '').trim()
    if (!trimmed) return null
    const createdAt = options.createdAt || new Date().toISOString()
    const messageId =
      options.messageId || `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const fromBuyer = options.fromBuyer === true
    const newMessage = {
      id: messageId,
      text: trimmed,
      createdAt,
      imageUrl: null,
      user: {
        username: fromBuyer ? String(chat.buyerName || '').trim() || null : getOurUsername(),
      },
      ...(options.optimistic ? { _optimisticOutgoing: true } : {}),
    }
    setChatStateById((prev) => ({
      ...prev,
      [chat.id]: {
        ...(prev[chat.id] || { loading: false, error: null, loaded: true, messages: [] }),
        messages: [...(prev[chat.id]?.messages || []), newMessage],
      },
    }))
    setChats((prev) =>
      sortChatsByLastMessageDesc(
        prev.map((c) =>
          c.id === chat.id
            ? {
                ...c,
                lastMessageId: messageId,
                lastMessageText: trimmed,
                lastMessageCreatedAt: createdAt,
                dealId: c.dealId || chat.dealId || null,
                unreadCount: fromBuyer ? Number(c.unreadCount || 0) : 0,
                lastMessageFromBuyer: fromBuyer,
              }
            : c
        )
      )
    )
    return {
      id: messageId,
      createdAt,
      text: trimmed,
    }
  }

  // Единая отправка с оптимистичным сообщением и откатом при ошибке.
  // Используется и для обычного ввода, и для кнопок быстрых команд.
  const deliverChatMessage = async (chat, rawText, { onError } = {}) => {
    if (!token || !chat?.id) return false
    const chatId = chat.id
    const text = String(rawText || '').trim()
    if (!text) return false
    const previousChatPreview = {
      lastMessageId: chat.lastMessageId || null,
      lastMessageText: chat.lastMessageText || null,
      lastMessageCreatedAt: chat.lastMessageCreatedAt || null,
      unreadCount: Number(chat.unreadCount || 0),
      lastMessageFromBuyer:
        typeof chat.lastMessageFromBuyer === 'boolean' ? chat.lastMessageFromBuyer : null,
    }
    const optimisticMessage = appendLocalMessageForChat(chat, text, { optimistic: true })
    if (!optimisticMessage) return false
    logChatLogging('action:sendMessage', { chat: summarizeChatForLog(chat), textLength: text.length }, 'action')
    try {
      const sendResult = await sendChatDbMessage(token, {
        dealId: chat.dealId || null,
        chatId,
        text,
        clientMessageId: String(optimisticMessage.id),
        clientCreatedAt: optimisticMessage.createdAt,
      })
      const serverMessage =
        sendResult && typeof sendResult.message === 'object' && sendResult.message !== null
          ? sendResult.message
          : null
      const resolvedId =
        serverMessage?.id != null ? String(serverMessage.id) : String(optimisticMessage.id)
      const resolvedText =
        serverMessage?.text != null ? String(serverMessage.text).trim() : optimisticMessage.text
      const resolvedCreatedAt = serverMessage?.createdAt || optimisticMessage.createdAt

      setChatStateById((prev) => {
        const current = prev[chatId] || {}
        const currentMessages = Array.isArray(current.messages) ? current.messages : []
        const nextMessages = currentMessages.map((m) =>
          String(m?.id || '') === String(optimisticMessage.id)
            ? {
                ...m,
                id: resolvedId,
                text: resolvedText,
                createdAt: resolvedCreatedAt,
                user: { ...(m.user || {}), username: getOurUsername() },
                _optimisticOutgoing: false,
              }
            : m
        )
        return {
          ...prev,
          [chatId]: {
            ...current,
            messages: nextMessages,
          },
        }
      })
      setChats((prev) =>
        sortChatsByLastMessageDesc(
          prev.map((c) =>
            c.id === chatId && String(c.lastMessageId || '') === String(optimisticMessage.id)
              ? {
                  ...c,
                  lastMessageId: resolvedId,
                  lastMessageText: resolvedText,
                  lastMessageCreatedAt: resolvedCreatedAt,
                  unreadCount: 0,
                  lastMessageFromBuyer: false,
                }
              : c
          )
        )
      )
      logChatLogging('action:sendMessage:success', { chatId }, 'action')
      return true
    } catch (err) {
      setChatStateById((prev) => {
        const current = prev[chatId] || {}
        const currentMessages = Array.isArray(current.messages) ? current.messages : []
        return {
          ...prev,
          [chatId]: {
            ...current,
            messages: currentMessages.filter(
              (m) => String(m?.id || '') !== String(optimisticMessage.id)
            ),
          },
        }
      })
      setChats((prev) =>
        sortChatsByLastMessageDesc(
          prev.map((c) =>
            c.id === chatId && String(c.lastMessageId || '') === String(optimisticMessage.id)
              ? {
                  ...c,
                  lastMessageId: previousChatPreview.lastMessageId,
                  lastMessageText: previousChatPreview.lastMessageText,
                  lastMessageCreatedAt: previousChatPreview.lastMessageCreatedAt,
                  unreadCount: previousChatPreview.unreadCount,
                  lastMessageFromBuyer: previousChatPreview.lastMessageFromBuyer,
                }
              : c
          )
        )
      )
      logChatLogging(
        'action:sendMessage:error',
        { chatId, message: err instanceof Error ? err.message : String(err) },
        'error'
      )
      if (typeof onError === 'function') onError(err, text)
      return false
    }
  }

  const handleSendMessage = async (chat) => {
    if (!token || !chat?.id) return
    const chatId = chat.id
    const text = (draftByChatId[chatId] || '').trim()
    if (!text) return
    setDraftByChatId((prev) => ({ ...prev, [chatId]: '' }))
    await deliverChatMessage(chat, text, {
      onError: (_err, failedText) => {
        // Возвращаем неотправленный текст обратно в поле ввода.
        setDraftByChatId((prev) => ({ ...prev, [chatId]: failedText }))
      },
    })
  }

  const openRequestCodeModal = (chat) => {
    if (!chat?.id || !moduleSupercellEnabled) return
    setRequestCodeState({ loading: false, error: null })
    setEmailDraftByChatId((prev) => ({
      ...prev,
      [chat.id]: Object.prototype.hasOwnProperty.call(prev, chat.id)
        ? prev[chat.id]
        : (manualEmailByChatId[chat.id] || chatStateById[chat.id]?.buyerSupercellEmail || ''),
    }))
    setRequestCodeModal({ open: true, chatId: chat.id })
  }

  const closeRequestCodeModal = () => {
    setRequestCodeModal({ open: false, chatId: null })
    setRequestCodeState({ loading: false, error: null })
  }

  const saveManualEmailForChat = (chatId, emailValue) => {
    const trimmed = String(emailValue || '').trim()
    if (!chatId) return
    setManualEmailByChatId((prev) => {
      const next = trimmed ? { ...prev, [chatId]: trimmed } : { ...prev }
      if (!trimmed) delete next[chatId]
      saveManualEmailsToStorage(next)
      return next
    })
  }

  const resetManualEmailForChat = (chatId) => {
    if (!chatId) return
    setManualEmailByChatId((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, chatId)) return prev
      const next = { ...prev }
      delete next[chatId]
      saveManualEmailsToStorage(next)
      return next
    })
    setEmailDraftByChatId((prev) => {
      const next = { ...prev }
      delete next[chatId]
      return next
    })
  }

  const handleRequestCodeForSelectedChat = async () => {
    if (!selectedChat || !token || !moduleSupercellEnabled) return
    const email = String(emailDraftByChatId[selectedChat.id] || '').trim()
    if (!isEmailValid(email)) {
      setRequestCodeState({ loading: false, error: 'Введите корректную почту Supercell ID' })
      return
    }
    setRequestCodeState({ loading: true, error: null })
    logChatLogging('action:requestSupercellCode', { chat: summarizeChatForLog(selectedChat), email }, 'action')
    try {
      const data = await requestSupercellCode(token, {
        dealId: selectedChat.dealId || null,
        chatId: selectedChat.id,
        email,
        category: selectedChatSupercellCategory || selectedChat.category || '',
      })
      saveManualEmailForChat(selectedChat.id, email)
      if (data?.chatMessage) {
        appendLocalMessageForChat(selectedChat, data.chatMessage)
      }
      closeRequestCodeModal()
      logChatLogging('action:requestSupercellCode:success', { chatId: selectedChat.id }, 'action')
    } catch (err) {
      logChatLogging(
        'action:requestSupercellCode:error',
        { chatId: selectedChat.id, message: err instanceof Error ? err.message : String(err) },
        'error'
      )
      setRequestCodeState({
        loading: false,
        error: err instanceof Error ? err.message : 'Не удалось запросить код',
      })
    }
  }

  const handleSaveEmailForSelectedChat = () => {
    if (!selectedChat) return
    const email = String(emailDraftByChatId[selectedChat.id] || '').trim()
    if (!isEmailValid(email)) {
      setRequestCodeState({ loading: false, error: 'Введите корректную почту Supercell ID' })
      return
    }
    saveManualEmailForChat(selectedChat.id, email)
    closeRequestCodeModal()
  }

  const pickDealIdFromMessages = (messages) => {
    const list = Array.isArray(messages) ? messages : []
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i]
      const id = m?.dealId != null ? String(m.dealId).trim() : m?.deal?.id != null ? String(m.deal.id).trim() : ''
      if (id) return id
    }
    return null
  }

  const handleApprouteRescan = async () => {
    if (!token || !selectedChat?.id) return
    setApprouteRescanState({ loading: true, error: null, notice: 'Отправляем запрос Api…' })
    const messages = selectedChatState?.messages || []
    const dealIdForRescan =
      selectedChat.dealId || pickDealIdFromMessages(messages) || undefined
    try {
      await rescanApprouteChat(token, {
        chatId: selectedChat.id,
        dealId: dealIdForRescan,
        dealItemId: selectedChat.itemId || undefined,
      })
      try {
        const { list, itemTitle, itemImageUrl, itemCategory, deals, viewerUsername, review } =
          await fetchChatDbMessages(token, {
            dealId: selectedChat.dealId || null,
            chatId: selectedChat.id,
          })
        noteViewerUsername(viewerUsername)
        applyLoadedChatData(
          selectedChat,
          list,
          itemTitle,
          itemImageUrl,
          null,
          itemCategory,
          deals,
          review || null
        )
      } catch (refreshErr) {
        const refreshMessage =
          refreshErr instanceof Error ? refreshErr.message : 'не удалось обновить чат'
        setApprouteRescanState({
          loading: false,
          error: null,
          notice: `Запрос Api отправлен, но чат не обновился: ${refreshMessage}`,
        })
        return
      }
      setApprouteRescanState({
        loading: false,
        error: null,
        notice: 'Готово: запрос Api отправлен.',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось выполнить рескан'
      if (err && err.pending) {
        setApprouteRescanState({ loading: false, error: null, notice: message })
      } else {
        setApprouteRescanState({ loading: false, error: message, notice: null })
      }
    }
  }

  const handleRecheckChat = async () => {
    if (!token || !selectedChat?.id) return
    setRecheckState({ loading: true, error: null, notice: 'Загружаем чат с Playerok…' })
    try {
      const result = await recheckChatDbChat(token, {
        chatId: selectedChat.id,
        dealId: selectedChat.dealId || undefined,
      })
      try {
        const { list, itemTitle, itemImageUrl, itemCategory, deals, viewerUsername, review } =
          await fetchChatDbMessages(token, {
            dealId: selectedChat.dealId || null,
            chatId: selectedChat.id,
          })
        noteViewerUsername(viewerUsername)
        applyLoadedChatData(
          selectedChat,
          list,
          itemTitle,
          itemImageUrl,
          null,
          itemCategory,
          deals,
          review || null
        )
      } catch (_refreshErr) {
        // данные перепроверены в БД, но обновить чат на экране не удалось — не критично
      }
      const added = Number(result?.added || 0)
      setRecheckState({
        loading: false,
        error: null,
        notice: added > 0 ? `Готово: добавлено новых сообщений — ${added}.` : 'Готово: новых сообщений не найдено.',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось выполнить перепроверку'
      setRecheckState({ loading: false, error: message, notice: null })
    }
  }

  const toggleHiddenForChat = async (chat) => {
    if (!token || !chat?.id) return
    const chatId = chat.id
    const currentlyHidden = Boolean(chat.isHidden)
    logChatLogging(
      'action:toggleHidden',
      { chat: summarizeChatForLog(chat), nextHidden: !currentlyHidden },
      'action'
    )
    try {
      if (!currentlyHidden) {
        await hideChat(token, chatId)
      } else {
        await unhideChat(token, chatId)
      }
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? { ...c, isHidden: !currentlyHidden }
            : c
        )
      )
      logChatLogging('action:toggleHidden:success', { chatId, hidden: !currentlyHidden }, 'action')
    } catch (err) {
      logChatLogging(
        'action:toggleHidden:error',
        { chatId, message: err instanceof Error ? err.message : String(err) },
        'error'
      )
    }
  }

  const closeDealActionModal = () => {
    setDealActionModal({ open: false, kind: null, chatId: null })
    setDealActionState({ loading: false, error: null, candidates: [], selectedDealId: null })
  }

  const openDealActionModal = (kind) => {
    if (!token || !selectedChat) return
    const allDeals = Array.isArray(selectedChatDeals) ? selectedChatDeals : []
    const seen = new Set()
    const activeDeals = []
    for (const d of allDeals) {
      const id = d?.dealId != null ? String(d.dealId).trim() : ''
      if (!id || seen.has(id)) continue
      const st = String(d?.status || '').toUpperCase()
      if (st === 'CONFIRMED' || st === 'ROLLED_BACK') continue
      seen.add(id)
      activeDeals.push(d)
    }
    const multiple = activeDeals.length > 1
    const defaultDealId = multiple
      ? null
      : activeDeals[0]?.dealId || selectedChat.dealId || null
    logChatLogging(
      'action:openDealModal',
      { kind, multiple, activeCount: activeDeals.length, chat: summarizeChatForLog(selectedChat) },
      'action'
    )
    setDealActionState({
      loading: false,
      error: null,
      candidates: multiple ? activeDeals : [],
      selectedDealId: defaultDealId,
    })
    setDealActionModal({ open: true, kind, chatId: selectedChat.id })
  }

  const handleDealActionConfirm = async () => {
    const { kind, chatId } = dealActionModal
    const chat = chats.find((c) => c.id === chatId)
    if (!token || !kind) return
    const needsPick = dealActionState.candidates.length > 1
    if (needsPick && !dealActionState.selectedDealId) {
      setDealActionState((prev) => ({
        ...prev,
        error: 'Выберите сделку, с которой выполнить действие.',
      }))
      return
    }
    const effectiveDealId =
      (dealActionState.selectedDealId != null ? String(dealActionState.selectedDealId).trim() : '') ||
      (chat?.dealId != null ? String(chat.dealId).trim() : '')
    if (!effectiveDealId) {
      setDealActionState((prev) => ({
        ...prev,
        loading: false,
        error: 'У этого чата нет ID сделки — запрос на Playerok отправить нельзя.',
      }))
      return
    }
    setDealActionState((prev) => ({ ...prev, loading: true, error: null }))
    logChatLogging('action:dealAction', { kind, dealId: effectiveDealId, chat: summarizeChatForLog(chat) }, 'action')
    try {
      if (kind === 'refund') {
        await cancelDeal(token, effectiveDealId)
      } else {
        await confirmDeal(token, effectiveDealId)
      }
      closeDealActionModal()
      logChatLogging('action:dealAction:success', { kind, chatId, dealId: effectiveDealId }, 'action')
      if (selectedChatId === chatId) {
        void loadMessagesForChat(chat)
      }
      try {
        const { list, pageInfo: info } = await fetchChatDbList(token, {
          limit: 24,
          offset: 0,
        })
        saveChatListScrollAnchor('prepend')
        setChats((prev) => mergeChatsWithRefresh(prev, list || []))
        setPageInfo(info || { hasNextPage: false, endCursor: null })
      } catch (_e) {
        // список обновится по таймеру
      }
    } catch (err) {
      logChatLogging(
        'action:dealAction:error',
        { kind, chatId, message: err instanceof Error ? err.message : String(err) },
        'error'
      )
      setDealActionState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Не удалось выполнить действие',
      }))
    }
  }

  const handleStartFullScan = async () => {
    if (!token) return
    setFullScanState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      await startChatDbFullScan(token)
      setFullScanState((prev) => ({ ...prev, loading: false }))
    } catch (err) {
      setFullScanState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  const handlePauseFullScan = async () => {
    setFullScanState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      await pauseChatDbScan()
      setFullScanState((prev) => ({ ...prev, loading: false }))
    } catch (err) {
      setFullScanState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  const handleStopFullScan = async () => {
    setFullScanState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      await stopChatDbScan()
      setFullScanState((prev) => ({ ...prev, loading: false }))
    } catch (err) {
      setFullScanState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  const selectedChatDerivedStatus = selectedChat ? getDerivedChatStatus(selectedChat) : ''
  const selectedChatOrderStatusLabel = selectedChat
    ? getOrderStatusLabel(selectedChatDerivedStatus)
    : ''

  return (
    <div className="tab-page tab-page--chat">
      <div className={`tab-grid ${isMobileChatLayout ? `tab-grid--chat-mobile-${mobileChatView}` : ''}`}>
        <section className="card">
          <h2 className="card-title">Список чатов</h2>
          {hasToken && (
            <div className="ddos-guard-actions" style={{ marginBottom: '0.6rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleStartFullScan}
                disabled={fullScanState.loading || fullScanInProgress}
              >
                {fullScanInProgress
                  ? 'Прогружаем чаты...'
                  : fullScanPaused
                    ? 'Продолжить прогрузку'
                    : 'Прогрузить чаты'}
              </button>
            </div>
          )}
          {hasToken && fullScanState.status && (
            <>
              {fullScanInProgress ? (
                <div className="profit-sync-progress" role="status" aria-live="polite" data-scan-tick={fullScanTick}>
                  <div className="profit-sync-progress__bar-wrap">
                    <div
                      className="profit-sync-progress__bar"
                      style={{ width: `${fullScanProgressPercent || 8}%` }}
                    />
                  </div>
                  <p className="profit-sync-progress__text">
                    {fullScanPhaseLabel ? `${fullScanPhaseLabel}: ` : 'Прогрузка: '}
                    {fullScanPhase === 'list'
                      ? `найдено ${fullScanDone}`
                      : `${fullScanDone} из ${fullScanTotal || '...'} (${fullScanProgressPercent}%)`}
                    {' · '}
                    Время: {Math.floor(fullScanElapsedSec / 60)}м {String(fullScanElapsedSec % 60).padStart(2, '0')}с
                    {fullScanCurrentLabel ? (
                      <>
                        {' · '}
                        {fullScanCurrentLabel}
                      </>
                    ) : null}
                  </p>
                  {fullScanLastError && fullScanCurrentStep === 'skip' && (
                    <p className="card-text card-text--error" style={{ marginTop: '0.35rem' }}>
                      {fullScanLastError}
                    </p>
                  )}
                  {fullScanUpdateLagSec >= 75 && fullScanCurrentStep === 'messages' && (
                    <p className="card-text" style={{ marginTop: '0.35rem' }}>
                      Долгая загрузка истории — через ~{Math.max(0, 90 - fullScanUpdateLagSec)}с чат будет пропущен.
                    </p>
                  )}
                  <div className="ddos-guard-actions" style={{ marginTop: '0.4rem' }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handlePauseFullScan}
                      disabled={fullScanState.loading}
                    >
                      Пауза
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleStopFullScan}
                      disabled={fullScanState.loading}
                    >
                      Стоп
                    </button>
                  </div>
                </div>
              ) : fullScanPaused ? (
                <p className="card-text" style={{ marginTop: 0 }}>
                  Прогрузка на паузе
                  {fullScanPhaseLabel ? ` (${fullScanPhaseLabel.toLowerCase()})` : ''}
                  {fullScanDone > 0 ? ` · обработано ${fullScanDone}` : ''}. Нажмите «Продолжить прогрузку».
                </p>
              ) : (
                <p className="card-text" style={{ marginTop: 0 }}>
                  {Number(fullScanState.status.full_scan_completed_at || 0) > 0
                    ? 'Полная прогрузка чатов уже выполнена.'
                    : 'Полная прогрузка ещё не запускалась.'}
                </p>
              )}
            </>
          )}
          {hasToken && fullScanState.error && (
            <p className="card-text card-text--error">{fullScanState.error}</p>
          )}

          {!hasToken && (
            <p className="card-text">
              Укажите токен во вкладке «Токен», чтобы увидеть чаты.
            </p>
          )}

          {hasToken && loading && chats.length === 0 && (
            <p className="card-text">Загружаем чаты с Playerok…</p>
          )}

          {hasToken && error && (
            <p className="card-text card-text--error">{error}</p>
          )}

          {hasToken && !loading && !error && chats.length === 0 && (
            <p className="card-text">
              Чатов пока нет.
            </p>
          )}

          {hasToken && !error && chats.length > 0 && (
            <>
              <div className="chat-filter-toggle">
                <button
                  type="button"
                  className={
                    chatFilter === 'all'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('all')}
                  aria-label="Показать все чаты"
                  title="Все чаты"
                >
                  <span aria-hidden="true">💬</span>
                </button>
                <button
                  type="button"
                  className={
                    chatFilter === 'hide-completed'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('hide-completed')}
                  aria-label="Только чаты в работе (без завершённых)"
                  title="Только в работе"
                >
                  <span aria-hidden="true">🛠️</span>
                </button>
                <button
                  type="button"
                  className={
                    chatFilter === 'only-fulfillment'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('only-fulfillment')}
                  aria-label="Только выполнение заказов и чаты с проблемой"
                  title="Только выполнение"
                >
                  <span aria-hidden="true">📦</span>
                </button>
                <button
                  type="button"
                  className={
                    chatFilter === 'test'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('test')}
                  aria-label="Тест: имитация покупок"
                  title="Тест"
                >
                  <span aria-hidden="true">🧪</span>
                </button>
              </div>
              <div
                ref={listRef}
                className="chat-list"
              >
                {visibleChats.map((chat) => {
                  const isActive = chat.id === selectedChatId
                  const unread = typeof chat.unreadCount === 'number' ? chat.unreadCount : null
                  const category = String(chat.category || '').trim() || 'Категория не определена'

                  const derivedStatus = getDerivedChatStatus(chat)
                  const statusIcon = getStatusIcon(derivedStatus)
                  const statusColor =
                    statusIcon.tone === 'success'
                      ? '#16a34a'
                      : statusIcon.tone === 'rollback'
                        ? '#ef4444'
                        : statusIcon.tone === 'work'
                          ? '#0ea5e9'
                          : statusIcon.tone === 'sent'
                            ? '#f59e0b'
                            : 'var(--text-muted)'

                  const displayName = String(chat.buyerName || '').trim() || 'Имя покупателя'
                  const lastMessagePreview = getLastChatMessagePreviewInfo(chat)
                  const hasUnread =
                    unread != null &&
                    unread > 0 &&
                    (lastMessagePreview ? lastMessagePreview.fromBuyer : true)

                  return (
                    <button
                      key={chat.id}
                      type="button"
                      className={
                        'chat-list__item' +
                        (isActive ? ' chat-list__item--active' : '') +
                        (hasUnread ? ' chat-list__item--unread' : '')
                      }
                      onClick={() => {
                        logChatLogging('action:selectChat', { chat: summarizeChatForLog(chat) }, 'action')
                        setSelectedChatId(chat.id)
                        void loadMessagesForChat(chat, { force: true })
                        markChatAsRead(chat.id)
                        if (isMobileChatLayout) {
                          setMobileChatView('chat')
                        }
                      }}
                    >
                      <div
                        className="chat-list__status-slot chat-list__preview--status-icon"
                        title={statusIcon.label}
                        aria-label={statusIcon.label}
                        style={{ color: statusColor }}
                      >
                        <span aria-hidden="true" className="chat-list__status-glyph">
                          {statusIcon.icon}
                        </span>
                      </div>
                      <div className="chat-list__main">
                        <div className="chat-list__title">
                          {displayName}
                        </div>
                        <div className="chat-list__meta">
                          <span className="chat-list__buyer">
                            {category}
                          </span>
                          {derivedStatus === 'CONFIRMED' ? renderReviewBadge(chat.review, { variant: 'list' }) : null}
                        </div>
                        {lastMessagePreview ? (
                          <div className="chat-list__buyer-last-msg">
                            <span
                              className={
                                'chat-list__buyer-last-msg-author ' +
                                (lastMessagePreview.fromBuyer
                                  ? 'chat-list__buyer-last-msg-author--buyer'
                                  : 'chat-list__buyer-last-msg-author--seller')
                              }
                            >
                              {lastMessagePreview.fromBuyer ? 'Заказчик:' : 'Вы:'}
                            </span>{' '}
                            <span className="chat-list__buyer-last-msg-text">{lastMessagePreview.text}</span>
                            {hasUnread && (
                              <span className="chat-list__unread-pill">
                                Новых: {unread}
                              </span>
                            )}
                          </div>
                        ) : null}
                        <div className="chat-list__item-footer">
                          <div className="chat-list__time">
                            {formatTime(chat.lastMessageCreatedAt)}
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
                {loadingMore && (
                  <p className="card-text" style={{ marginTop: '0.5rem' }}>
                    Загружаем ещё чаты…
                  </p>
                )}
              </div>
            </>
          )}
        </section>

        <section className="card">
          <button
            type="button"
            className="chat-mobile-back-btn"
            onClick={() => setMobileChatView('list')}
          >
            ← Чаты
          </button>
          <h2 className="card-title">Сообщения</h2>
          {!hasToken && (
            <p className="card-text">
              Сообщения чатов недоступны без токена.
            </p>
          )}
          {hasToken && !selectedChat && (
            <p className="card-text">
              Выберите чат слева, чтобы увидеть сообщения.
            </p>
          )}
          {hasToken && selectedChat && isTestChat && (
            <>
              <div className="chat-header-row">
                <div className="card-text chat-header-row__info">
                  <div className="chat-header-row__text">
                    <strong>Тест покупки</strong>
                    {testProductLabel ? (
                      <span className="chat-header-row__buyer">Товар: {testProductLabel}</span>
                    ) : null}
                    <span className="chat-header-row__buyer">
                      {isBuyerView ? 'Вид покупателя' : 'Вид продавца'}
                    </span>
                  </div>
                </div>
                <div className="chat-header-row__center">
                  {testChatActive && !isBuyerView ? (
                    <div className="chat-header-row__deal-btns" aria-label="Действия продавца">
                      <button
                        type="button"
                        className="chat-header-row__deal-btn chat-header-row__deal-btn--confirm"
                        onClick={() => openTestDealActionModal('item_sent')}
                        disabled={!token || testEventLoading || testDealsForItemSent.length === 0}
                        title="Отметить отправку товара и запустить автоматику"
                      >
                        {testEventLoading ? '…' : 'Отправить Товар'}
                      </button>
                    </div>
                  ) : null}
                  {testChatActive && isBuyerView ? (
                    <div className="chat-header-row__deal-btns" aria-label="Действия покупателя">
                      <button
                        type="button"
                        className="chat-header-row__deal-btn chat-header-row__deal-btn--confirm"
                        onClick={() => openTestDealActionModal('deal_confirmed')}
                        disabled={!token || testEventLoading || testDealsForConfirm.length === 0}
                        title="Подтвердить сделку со стороны заказчика"
                      >
                        {testEventLoading ? '…' : 'Сделка подтверждена'}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="chat-messages">
                {testMessages.length === 0 && !isBuyerView ? (
                  <p className="card-text">Выберите товар и нажмите «Купить».</p>
                ) : testMessages.length === 0 ? null : (
                  testMessages.map((m) => {
                    let cls
                    if (m.role === 'system') {
                      cls = 'chat-message chat-message--system'
                    } else if (m.role === 'buyer') {
                      cls = isBuyerView
                        ? 'chat-message chat-message--seller'
                        : 'chat-message chat-message--buyer'
                    } else if (m.role === 'seller') {
                      cls = isBuyerView
                        ? 'chat-message chat-message--buyer'
                        : 'chat-message chat-message--seller'
                    } else {
                      cls = isBuyerView
                        ? 'chat-message chat-message--buyer'
                        : 'chat-message chat-message--seller'
                    }
                    const text = String(m.text || '').trim()
                    return (
                      <div key={m.id} className={cls}>
                        <div className="chat-message__bubble">
                          {text ? (
                            <div className="chat-message__text-wrapper">
                              <div className="chat-message__text">{formatMessageText(m.text)}</div>
                            </div>
                          ) : null}
                          {m.imageUrl ? (
                            <div className="chat-message__image-wrap">
                              <a
                                href={m.imageUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="chat-message__image-btn"
                                title="Открыть изображение"
                              >
                                <img
                                  src={m.imageUrl}
                                  alt="Изображение в чате"
                                  className="chat-message__image"
                                />
                              </a>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
              {testError && (
                <p className="card-text card-text--error" role="status" aria-live="polite">
                  {testError}
                </p>
              )}
              {testChatActive && testWaiting && isBuyerView && (
                <p className="card-text" role="status" aria-live="polite">
                  Бот ждёт ответ покупателя: {testInputHint}
                </p>
              )}
              {testChatActive && (
                <form
                  className="deal-chat-row__input"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void sendTestMessage()
                  }}
                >
                  <input
                    type="text"
                    className="deal-chat-row__input-field"
                    value={testDraft}
                    onChange={(e) => setTestDraft(e.target.value)}
                    placeholder={isBuyerView ? 'Сообщение покупателя…' : 'Сообщение продавца…'}
                    disabled={testSending}
                    aria-label={isBuyerView ? 'Сообщение покупателя' : 'Сообщение продавца'}
                  />
                  <button
                    type="submit"
                    className="deal-chat-row__input-btn"
                    disabled={!testDraft.trim() || testSending}
                  >
                    {testSending ? '…' : 'Отправить'}
                  </button>
                </form>
              )}
              {!isBuyerView && (
                <form
                  className="deal-chat-row__input"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void runTestPurchase()
                  }}
                >
                  <select
                    className="deal-chat-row__input-field"
                    value={testProductKey}
                    onChange={(e) => setTestProductKey(e.target.value)}
                    aria-label="Товар для тест-покупки"
                    disabled={loadingLots || testRunning}
                  >
                    <option value="">
                      {loadingLots ? 'Загрузка лотов…' : 'Выберите товар…'}
                    </option>
                    {testProductOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="deal-chat-row__input-btn"
                    disabled={!token || !testProductKey || testRunning}
                  >
                    {testRunning ? 'Покупаем…' : 'Купить'}
                  </button>
                </form>
              )}
            </>
          )}
          {hasToken && selectedChat && !isTestChat && (
            <>
              <div className="chat-header-row">
                <div className="card-text chat-header-row__info">
                  <div className="chat-header-row__text">
                    <strong>Чат по товару</strong>
                    {selectedChat.buyerName ? (
                      <span className="chat-header-row__buyer">
                        Покупатель: {selectedChat.buyerName}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="chat-header-row__center">
                  {selectedChatDerivedStatus !== 'CONFIRMED' ? (
                    <div className="chat-header-row__deal-btns" aria-label="Быстрые действия со сделкой">
                      <button
                        type="button"
                        className="chat-header-row__deal-btn chat-header-row__deal-btn--refund"
                        disabled={!token}
                        title="Оформить возврат на Playerok"
                        onClick={() => openDealActionModal('refund')}
                      >
                        Возврат
                      </button>
                      <button
                        type="button"
                        className="chat-header-row__deal-btn chat-header-row__deal-btn--confirm"
                        disabled={!token}
                        title="Подтвердить сделку на Playerok"
                        onClick={() => openDealActionModal('confirm')}
                      >
                        Подтвердить сделку
                      </button>
                    </div>
                  ) : null}
                  {selectedChatOrderStatusLabel ? (
                    <span className="chat-header-row__order-status">Статус: {selectedChatOrderStatusLabel}</span>
                  ) : null}
                </div>
                <div className="chat-header-row__actions">
                  <button
                    type="button"
                    className="chat-header-row__hide-btn chat-header-row__logic-btn"
                    title="Показать логику работы бота по этому товару"
                    onClick={() => setWorkLogicOpen(true)}
                  >
                    Логика работы
                  </button>
                  <button
                    type="button"
                    className="chat-header-row__hide-btn"
                    disabled={!token || recheckState.loading}
                    title="Загрузить чат с Playerok и добавить недостающие сообщения в БД"
                    onClick={() => void handleRecheckChat()}
                  >
                    {recheckState.loading ? 'Перепроверяем…' : 'Перепроверка'}
                  </button>
                  {selectedChatApprouteEnabled && (
                    <button
                      type="button"
                      className="chat-header-row__hide-btn"
                      disabled={!token || approuteRescanState.loading}
                      onClick={() => void handleApprouteRescan()}
                    >
                      {approuteRescanState.loading ? 'Проверяем Api…' : 'Повтор Api'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="chat-header-row__hide-btn"
                    onClick={() => toggleHiddenForChat(selectedChat)}
                  >
                    {selectedChat.isHidden ? 'Показать чат' : 'Скрыть чат'}
                  </button>
                  <button
                    type="button"
                    className="chat-header-row__hide-btn"
                    onClick={() => setShowChatExtraInfo((v) => !v)}
                  >
                    {showChatExtraInfo ? 'Скрыть доп инфо' : 'Доп инфо'}
                  </button>
                </div>
              </div>
              {selectedChatApprouteEnabled && approuteRescanState.error && (
                <p className="card-text card-text--error" role="status" aria-live="polite">
                  {approuteRescanState.error}
                </p>
              )}
              {selectedChatApprouteEnabled && approuteRescanState.notice && (
                <p className="card-text" role="status" aria-live="polite">
                  {approuteRescanState.notice}
                </p>
              )}
              {recheckState.error && (
                <p className="card-text card-text--error" role="status" aria-live="polite">
                  {recheckState.error}
                </p>
              )}
              {recheckState.notice && (
                <p className="card-text" role="status" aria-live="polite">
                  {recheckState.notice}
                </p>
              )}
              <div className={'chat-item-card' + (mobileCardExpanded ? ' chat-item-card--mexpanded' : '')}>
                <div className="chat-item-card__image-wrap">
                  {currentItemImageUrl ? (
                    <img
                      src={currentItemImageUrl}
                      alt={currentItemTitle || ''}
                      className="chat-item-card__image"
                    />
                  ) : (
                    <div className="chat-item-card__placeholder">
                      Нет фото
                    </div>
                  )}
                </div>
                <div className="chat-item-card__body">
                  {currentItemTitle && (
                    <div className="chat-item-card__title">
                      {currentItemTitle}
                    </div>
                  )}
                  <button
                    type="button"
                    className="chat-item-card__mtoggle"
                    onClick={() => setMobileCardExpanded((v) => !v)}
                  >
                    {mobileCardExpanded ? 'Скрыть детали ▴' : 'Показать детали (финансы, почта) ▾'}
                  </button>
                  {selectedChat.buyerName ? (
                    <div className="chat-item-card__buyer">
                      Покупатель: {selectedChat.buyerName}
                    </div>
                  ) : null}
                  {(selectedChatDerivedStatus === 'CONFIRMED' ||
                    selectedChatState?.review?.left ||
                    selectedChat?.review?.left) && (() => {
                    const headerReview = selectedChatState?.review || selectedChat?.review || null
                    return (
                      <div className="chat-item-card__review">
                        Отзыв покупателя: {renderReviewBadge(headerReview, { variant: 'header' })}
                      </div>
                    )
                  })()}
                  {selectedChatDeals.length > 0 && (
                    <div className="chat-item-card__buyer">
                      Покупки в чате: {selectedChatDeals.map((d) => d.itemCategory || 'Без категории').join(' · ')}
                    </div>
                  )}
                  {(() => {
                    // В шапке — только текущая (последняя) сделка. Предыдущие сделки
                    // показываются инлайн в ленте сообщений по мере прокрутки к ним.
                    const primaryDeal = selectedChatDeals.find(
                      (d) =>
                        d &&
                        d.financials &&
                        selectedChatPrimaryDealId &&
                        String(d.dealId) === String(selectedChatPrimaryDealId)
                    )
                    const headerDeal =
                      primaryDeal ||
                      (selectedChatDeals.length === 1
                        ? selectedChatDeals.find((d) => d && d.financials)
                        : null)
                    if (!headerDeal) return null
                    return (
                      <div className="chat-item-card__financials">
                        {renderDealFinCard(headerDeal, { showTitle: false })}
                      </div>
                    )
                  })()}
                  {(selectedChatCanUseSupercell || selectedChatDetectedEmail) && (
                    <div
                      className={
                        'chat-item-card__email-box ' +
                        (selectedChatEmail
                          ? selectedChatEmailIsValid
                            ? 'deal-chat-row__email-box--valid'
                            : 'deal-chat-row__email-box--invalid'
                          : '')
                      }
                    >
                      <span className="deal-chat-row__email-label">Почта Supercell ID:</span>
                      <span className="deal-chat-row__email-value">
                        {selectedChatEmail || 'Не указана'}
                      </span>
                      <button
                        type="button"
                        className="lot-settings-btn lot-settings-btn--secondary"
                        onClick={() => openRequestCodeModal(selectedChat)}
                      >
                        Изменить
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {showChatExtraInfo && (
                <div className="card-text" style={{ marginTop: '0.6rem' }}>
                  <div>Chat ID: {selectedChat.id || '—'}</div>
                  <div>Deal ID: {selectedChat.dealId || '—'}</div>
                  <div>Item ID: {selectedChat.itemId || '—'}</div>
                  <div>Buyer: {selectedChat.buyerName || '—'}</div>
                  <div>Category: {selectedChat.category || '—'}</div>
                  <div>Last message ID: {selectedChat.lastMessageId || '—'}</div>
                  {selectedChatDeals.length > 0 && (
                    <div>
                      Deals in chat: {selectedChatDeals.map((d) => d.dealId || '—').join(', ')}
                    </div>
                  )}
                </div>
              )}
              {(() => {
                const baseMessages = mergeListAheadMessage(
                  selectedChat,
                  selectedChatState?.messages || []
                )
                const feedReview = selectedChatState?.review || selectedChat?.review || null
                let messagesToRender = baseMessages
                if (feedReview && feedReview.left === true) {
                  const reviewMsg = {
                    id: '__review__',
                    createdAt: feedReview.createdAt || null,
                    _reviewBadge: feedReview,
                  }
                  const reviewTs = feedReview.createdAt ? Date.parse(feedReview.createdAt) : NaN
                  if (Number.isFinite(reviewTs)) {
                    const next = [...baseMessages]
                    let insertAt = next.findIndex((m) => {
                      const ts = m?.createdAt ? Date.parse(m.createdAt) : NaN
                      return Number.isFinite(ts) && ts > reviewTs
                    })
                    if (insertAt < 0) insertAt = next.length
                    next.splice(insertAt, 0, reviewMsg)
                    messagesToRender = next
                  } else {
                    messagesToRender = [...baseMessages, reviewMsg]
                  }
                }
                if (messagesToRender.length === 0) {
                  if (selectedChatMessagesPending) {
                    return <p className="card-text">Загружаем чат…</p>
                  }
                  if (selectedChatState?.error) {
                    return (
                      <p className="card-text card-text--error">
                        {selectedChatState.error}
                      </p>
                    )
                  }
                  return (
                    <p className="card-text">Сообщений в этом чате пока нет.</p>
                  )
                }
                // Финансы предыдущих сделок — инлайн в ленте у начала каждой сделки
                // (первое сообщение с её deal_id). Текущую сделку показываем в шапке.
                const financialsByDeal = new Map()
                for (const d of selectedChatDeals) {
                  if (d && d.dealId && d.financials) financialsByDeal.set(String(d.dealId), d)
                }
                const cardBeforeMessageId = new Map()
                const seenFinDeals = new Set()
                for (const m of messagesToRender) {
                  const did = m && m.dealId ? String(m.dealId) : null
                  if (!did || seenFinDeals.has(did)) continue
                  seenFinDeals.add(did)
                  if (selectedChatPrimaryDealId && did === String(selectedChatPrimaryDealId)) continue
                  const deal = financialsByDeal.get(did)
                  if (deal && m.id != null) cardBeforeMessageId.set(String(m.id), deal)
                }
                return (
                  <div ref={messagesRef} className="chat-messages">
                    {selectedChatMessagesPending && (
                      <p className="card-text chat-messages__loading-hint">
                        Загружаем историю…
                      </p>
                    )}
                    {messagesToRender.map((m) => {
                        if (m._reviewBadge) {
                          const rv = m._reviewBadge
                          const ratingNum = Number(rv.rating)
                          const hasRating = Number.isFinite(ratingNum) && ratingNum > 0
                          const stars = hasRating
                            ? '★'.repeat(ratingNum) + '☆'.repeat(Math.max(0, 5 - ratingNum))
                            : ''
                          const reviewTimeText = formatTime(m.createdAt)
                          return (
                            <div key={m.id} className="chat-message chat-message--system">
                              <div className="chat-message__bubble">
                                <div className="chat-message__system-header">
                                  <span className="chat-message__system-icon" title="Системное сообщение">
                                    ⚙️
                                  </span>
                                  <span className="chat-message__system-label">Системное сообщение</span>
                                </div>
                                <div className="chat-message__text">
                                  {hasRating
                                    ? `Покупатель оставил отзыв: ${stars} (${ratingNum} из 5)`
                                    : 'Покупатель оставил отзыв'}
                                </div>
                                {reviewTimeText && (
                                  <div className="chat-message__time">{reviewTimeText}</div>
                                )}
                              </div>
                            </div>
                          )
                        }
                        const timeText = formatTime(m.createdAt)
                        const isSystem = m.text ? isSystemMessage(m.text) : false
                        const fromBuyer = isFromBuyer(m)
                        // Для системных сообщений используем только класс system, иначе определяем по автору
                        const messageClass = isSystem
                          ? 'chat-message chat-message--system'
                          : `chat-message ${fromBuyer ? 'chat-message--buyer' : 'chat-message--seller'}`
                        const inlineFinDeal = cardBeforeMessageId.get(String(m.id))
                        const messageNode = (
                          <div key={m.id} className={messageClass}>
                            <div className="chat-message__bubble">
                              {isSystem && (
                                <div className="chat-message__system-header">
                                  <span className="chat-message__system-icon" title="Системное сообщение">
                                    ⚙️
                                  </span>
                                  <span className="chat-message__system-label">Системное сообщение</span>
                                </div>
                              )}
                              {!isSystem && m.text ? (
                                <div className="chat-message__text-wrapper">
                                  <div className="chat-message__text">
                                    {formatMessageText(m.text)}
                                  </div>
                                  {timeText && (
                                    <div className="chat-message__time">
                                      {timeText}
                                    </div>
                                  )}
                                </div>
                              ) : isSystem && m.text ? (
                                <div className="chat-message__text">
                                  {formatMessageText(m.text)}
                                </div>
                              ) : null}
                              {m.imageUrl ? (
                                <div className="chat-message__image-wrap">
                                  <a
                                    href={m.imageUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="chat-message__image-btn"
                                    title="Открыть изображение"
                                  >
                                    <img
                                      src={m.imageUrl}
                                      alt="Изображение в чате"
                                      className="chat-message__image"
                                    />
                                  </a>
                                </div>
                              ) : null}
                              {m.imageUrl && !m.text && timeText ? (
                                <div className="chat-message__time">
                                  {timeText}
                                </div>
                              ) : null}
                              {!m.text && !m.imageUrl && (
                                <div className={isSystem ? "chat-message__text chat-message__placeholder" : "chat-message__text-wrapper"}>
                                  {!isSystem ? (
                                    <>
                                      <div className="chat-message__text chat-message__placeholder">
                                        Сообщение без текста
                                      </div>
                                      {timeText && (
                                        <div className="chat-message__time">
                                          {timeText}
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    "Сообщение без текста"
                                  )}
                                </div>
                              )}
                              {isSystem && timeText && (
                                <div className="chat-message__time">
                                  {timeText}
                                </div>
                              )}
                            </div>
                          </div>
                        )
                        if (inlineFinDeal) {
                          return [
                            <div className="chat-deal-fin-inline" key={`fin-${m.id}`}>
                              {renderDealFinCard(inlineFinDeal, { showTitle: true })}
                            </div>,
                            messageNode,
                          ]
                        }
                        return messageNode
                      })}
                    </div>
                  )
                })()}

              {!selectedChatState?.error && (
                <>
                  {(currentCategoryCommands.length > 0 || selectedChatCanUseSupercell) && (
                    <div className="chat-commands-buttons" style={{ marginBottom: '1rem' }}>
                      <div className="chat-commands-buttons__label" style={{
                        fontSize: '0.875rem',
                        color: 'var(--text-secondary, #666)',
                        marginBottom: '0.5rem'
                      }}>
                        Быстрые команды:
                      </div>
                      <div className="chat-commands-buttons__list" style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '0.5rem'
                      }}>
                        {currentCategoryCommands.map((cmd, index) => {
                          const buttonColor = cmd.color || '#6c757d'
                          const textColor = getTextColor(buttonColor)
                          return (
                            <button
                              key={cmd.id || index}
                              type="button"
                              className="btn-secondary"
                              style={{
                                fontSize: '0.875rem',
                                padding: '0.5rem 1rem',
                                backgroundColor: buttonColor,
                                borderColor: buttonColor,
                                color: textColor,
                                transition: 'background-color 0.2s ease, border-color 0.2s ease',
                              }}
                              onMouseEnter={(e) => {
                                // Немного затемняем при наведении
                                const rgb = hexToRgb(buttonColor)
                                if (rgb) {
                                  const darkerR = Math.max(0, rgb.r - 20)
                                  const darkerG = Math.max(0, rgb.g - 20)
                                  const darkerB = Math.max(0, rgb.b - 20)
                                  const darkerColor = `rgb(${darkerR}, ${darkerG}, ${darkerB})`
                                  e.target.style.backgroundColor = darkerColor
                                  e.target.style.borderColor = darkerColor
                                  // Обновляем цвет текста для затемненного фона
                                  const darkerLuminance = getLuminance(darkerR, darkerG, darkerB)
                                  e.target.style.color = darkerLuminance > 128 ? '#000' : '#fff'
                                }
                              }}
                              onMouseLeave={(e) => {
                                e.target.style.backgroundColor = buttonColor
                                e.target.style.borderColor = buttonColor
                                e.target.style.color = textColor
                              }}
                              onClick={() => {
                                if (!selectedChat || !token) return
                                void deliverChatMessage(selectedChat, cmd.text)
                              }}
                            >
                              {cmd.label}
                            </button>
                          )
                        })}
                        {selectedChatCanUseSupercell && (
                          <button
                            type="button"
                            className="deal-chat-row__command-btn"
                            onClick={() => openRequestCodeModal(selectedChat)}
                          >
                            Запросить код
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <form
                    className="deal-chat-row__input"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (!selectedChat) return
                      handleSendMessage(selectedChat)
                    }}
                  >
                    <input
                      type="text"
                      className="deal-chat-row__input-field"
                      placeholder="Написать сообщение…"
                      value={draftByChatId[selectedChat.id] || ''}
                      onChange={(e) =>
                        setDraftByChatId((prev) => ({
                          ...prev,
                          [selectedChat.id]: e.target.value,
                        }))
                      }
                    />
                    <button
                      type="submit"
                      className="deal-chat-row__input-btn"
                      disabled={
                        !token || !(draftByChatId[selectedChat.id] || '').trim()
                      }
                    >
                      Отправить
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </section>
      </div>
      {requestCodeModal.open && selectedChat && requestCodeModal.chatId === selectedChat.id && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!requestCodeState.loading) closeRequestCodeModal()
          }}
          role="presentation"
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Запросить код Supercell"
          >
            <div className="modal__header">
              <h3 className="modal__title">Запросить код</h3>
              <button
                type="button"
                className="modal__close"
                onClick={closeRequestCodeModal}
                disabled={requestCodeState.loading}
                aria-label="Закрыть"
              >
                x
              </button>
            </div>
            <div className="modal__body">
              <p className="card-text" style={{ marginTop: 0 }}>
                Категория: <strong>{selectedChat.category || '—'}</strong>
              </p>
              <label className="field">
                <span className="field-label">Почта Supercell ID</span>
                <input
                  type="email"
                  className={
                    'deal-chat-row__email-input ' +
                    (selectedChatEmailDraft
                      ? selectedChatEmailDraftIsValid
                        ? 'deal-chat-row__email-input--valid'
                        : 'deal-chat-row__email-input--invalid'
                      : '')
                  }
                  value={selectedChatEmailDraft}
                  onChange={(e) =>
                    setEmailDraftByChatId((prev) => ({
                      ...prev,
                      [selectedChat.id]: e.target.value,
                    }))
                  }
                  placeholder="Введите почту"
                />
              </label>
              {selectedChatEmailDraft && (
                <p
                  className={
                    'card-text ' +
                    (selectedChatEmailDraftIsValid
                      ? 'chat-request-code__email-status chat-request-code__email-status--valid'
                      : 'card-text--error chat-request-code__email-status')
                  }
                >
                  {selectedChatEmailDraftIsValid
                    ? 'Почта валидная'
                    : 'Почта невалидная'}
                </p>
              )}
              {selectedChatDetectedEmail && selectedChatDetectedEmail !== selectedChatEmailDraft && (
                <p className="deal-chat-row__email-hint">
                  Автоопределена: {selectedChatDetectedEmail}
                </p>
              )}
              {requestCodeState.error && (
                <p className="card-text card-text--error">
                  {requestCodeState.error}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
                {selectedChatManualEmail && (
                  <button
                    type="button"
                    className="lot-settings-btn lot-settings-btn--secondary"
                    onClick={() => resetManualEmailForChat(selectedChat.id)}
                    disabled={requestCodeState.loading}
                  >
                    Вернуть авто
                  </button>
                )}
                <button
                  type="button"
                  className="lot-settings-btn lot-settings-btn--secondary"
                  onClick={closeRequestCodeModal}
                  disabled={requestCodeState.loading}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="lot-settings-btn lot-settings-btn--secondary"
                  onClick={handleSaveEmailForSelectedChat}
                  disabled={requestCodeState.loading || !selectedChatEmailDraftIsValid}
                >
                  Сохранить почту
                </button>
                <button
                  type="button"
                  className="deal-chat-row__command-btn"
                  onClick={handleRequestCodeForSelectedChat}
                  disabled={requestCodeState.loading || !selectedChatEmailDraftIsValid}
                >
                  {requestCodeState.loading ? 'Запрашиваем код...' : 'Запросить код'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {workLogicOpen && selectedChat && (
        <div
          className="modal-backdrop"
          onClick={() => setWorkLogicOpen(false)}
          role="presentation"
        >
          <div
            className="modal modal--wide chat-logic-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Логика работы товара"
          >
            <div className="modal__header">
              <h3 className="modal__title">Логика работы</h3>
              <button
                type="button"
                className="modal__close"
                onClick={() => setWorkLogicOpen(false)}
                aria-label="Закрыть"
              >
                x
              </button>
            </div>
            <div className="modal__body">
              <p className="card-text chat-logic-modal__subtitle" style={{ marginTop: 0 }}>
                {currentItemTitle || 'Товар'}
                {selectedChat.category ? ` · ${selectedChat.category}` : ''}
              </p>
              {selectedChatEffectiveSettings &&
                String(selectedChatEffectiveSettings.settingsLabel || '').trim() && (
                  <p className="card-text chat-logic-modal__group">
                    Группа настроек:{' '}
                    <strong>{String(selectedChatEffectiveSettings.settingsLabel).trim()}</strong>
                  </p>
                )}
              {!selectedChatEffectiveSettings ? (
                <p className="card-text card-text--error">
                  Настройки для этого товара не найдены — категория/название не совпали с настройками
                  в разделе «Лоты». Бот не выполнит автоматику по этому товару.
                </p>
              ) : !selectedChatWorkLogic.hasAnySteps ? (
                <p className="card-text">
                  Для этого товара не настроена автоматика (автосообщения, автовыдача, пополнение
                  и т.д.).
                </p>
              ) : (
                <div className="chat-logic">
                  {selectedChatWorkLogic.stages
                    .filter((stage) => stage.steps.length > 0)
                    .map((stage) => (
                      <section className="chat-logic-stage" key={stage.key}>
                        <header className="chat-logic-stage__head">
                          <span className="chat-logic-stage__title">{stage.label}</span>
                          <span className="chat-logic-stage__marker">{stage.marker}</span>
                        </header>
                        {stage.conditional && stage.conditionNote && (
                          <p className="chat-logic-stage__cond">{stage.conditionNote}</p>
                        )}
                        <ol className="chat-logic-steps">
                          {stage.steps.map((step, i) => (
                            <li
                              key={i}
                              className={'chat-logic-step' + (step.active ? '' : ' chat-logic-step--off')}
                            >
                              <div className="chat-logic-step__row">
                                <span className="chat-logic-step__badge">{step.label}</span>
                                {step.detail && (
                                  <span className="chat-logic-step__detail">{step.detail}</span>
                                )}
                                {step.waitsForBuyer && (
                                  <span className="chat-logic-step__tag chat-logic-step__tag--wait">
                                    ⏸ ждёт ответа покупателя
                                  </span>
                                )}
                                {step.autoComplete && (
                                  <span className="chat-logic-step__tag chat-logic-step__tag--auto">
                                    → отметит «Товар отправлен»
                                  </span>
                                )}
                                {!step.active && step.inactiveReason && (
                                  <span className="chat-logic-step__tag chat-logic-step__tag--off">
                                    {step.inactiveReason}
                                  </span>
                                )}
                              </div>
                              {step.note && <div className="chat-logic-step__note">{step.note}</div>}
                              {step.text && <div className="chat-logic-step__text">{step.text}</div>}
                              {step.imageUrl && (
                                <img
                                  src={step.imageUrl}
                                  alt={step.filename || 'Картинка автосообщения'}
                                  className="chat-logic-step__img"
                                />
                              )}
                              {Array.isArray(step.substeps) && step.substeps.length > 0 && (
                                <div className="chat-logic-substeps">
                                  {step.substeps.map((sub, j) => (
                                    <div className="chat-logic-substep" key={j}>
                                      <span className="chat-logic-substep__label">{sub.label}:</span>
                                      <span className="chat-logic-substep__text">{sub.text}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </li>
                          ))}
                        </ol>
                      </section>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {testDealActionModal.open && testDealActionModal.kind && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!testDealActionState.loading) closeTestDealActionModal()
          }}
          role="presentation"
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={
              testDealActionModal.kind === 'item_sent' ? 'Отправить товар' : 'Подтвердить сделку'
            }
          >
            <div className="modal__header">
              <h3 className="modal__title">
                {testDealActionModal.kind === 'item_sent' ? 'Отправить Товар?' : 'Сделка подтверждена?'}
              </h3>
              <button
                type="button"
                className="modal__close"
                onClick={closeTestDealActionModal}
                disabled={testDealActionState.loading}
                aria-label="Закрыть"
              >
                x
              </button>
            </div>
            <div className="modal__body">
              <p className="card-text" style={{ marginTop: 0 }}>
                {testDealActionModal.kind === 'item_sent'
                  ? 'Отметить отправку товара по выбранной сделке и запустить автоматику.'
                  : 'Подтвердить получение по выбранной сделке и запустить автоматику.'}
              </p>
              {testDealActionState.candidates.length > 1 && (
                <div className="deal-action-picker">
                  <p className="card-text deal-action-picker__hint" style={{ marginTop: 0, marginBottom: 8 }}>
                    В чате несколько сделок. Выберите, с какой выполнить действие:
                  </p>
                  <div className="deal-action-picker__list">
                    {testDealActionState.candidates.map((d) => {
                      const id = String(d.dealId)
                      const checked = String(testDealActionState.selectedDealId || '') === id
                      return (
                        <label
                          key={id}
                          className={
                            'deal-action-picker__item' +
                            (checked ? ' deal-action-picker__item--active' : '')
                          }
                        >
                          <input
                            type="radio"
                            name="test-deal-action-pick"
                            value={id}
                            checked={checked}
                            disabled={testDealActionState.loading}
                            onChange={() =>
                              setTestDealActionState((prev) => ({
                                ...prev,
                                selectedDealId: id,
                                error: null,
                              }))
                            }
                          />
                          <span className="deal-action-picker__item-text">
                            <span className="deal-action-picker__item-title">
                              {d.label || 'Без названия'}
                            </span>
                            <span className="deal-action-picker__item-meta">#{id.slice(0, 8)}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
              {testDealActionState.error && (
                <p className="card-text card-text--error">{testDealActionState.error}</p>
              )}
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                  marginTop: 16,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  className="lot-settings-btn lot-settings-btn--secondary"
                  onClick={closeTestDealActionModal}
                  disabled={testDealActionState.loading}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="deal-chat-row__command-btn"
                  onClick={handleTestDealActionConfirm}
                  disabled={
                    testDealActionState.loading ||
                    (testDealActionState.candidates.length > 1 && !testDealActionState.selectedDealId)
                  }
                >
                  {testDealActionState.loading
                    ? 'Выполняем…'
                    : testDealActionModal.kind === 'item_sent'
                      ? 'Отправить Товар'
                      : 'Сделка подтверждена'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {dealActionModal.open && dealActionModal.kind && dealActionModal.chatId && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!dealActionState.loading) closeDealActionModal()
          }}
          role="presentation"
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={
              dealActionModal.kind === 'refund'
                ? 'Подтверждение возврата'
                : 'Подтверждение сделки'
            }
          >
            <div className="modal__header">
              <h3 className="modal__title">
                {dealActionModal.kind === 'refund'
                  ? 'Оформить возврат?'
                  : 'Подтвердить сделку?'}
              </h3>
              <button
                type="button"
                className="modal__close"
                onClick={closeDealActionModal}
                disabled={dealActionState.loading}
                aria-label="Закрыть"
              >
                x
              </button>
            </div>
            <div className="modal__body">
              <p className="card-text" style={{ marginTop: 0 }}>
                {dealActionModal.kind === 'refund'
                  ? 'Вы уверены, что хотите оформить возврат товара? Сделка на Playerok будет отменена.'
                  : 'Вы уверены, что хотите подтвердить сделку? На Playerok будет зафиксировано, что товар отправлен покупателю.'}
              </p>
              {dealActionState.candidates.length > 1 && (
                <div className="deal-action-picker">
                  <p className="card-text deal-action-picker__hint" style={{ marginTop: 0, marginBottom: 8 }}>
                    У покупателя несколько активных сделок. Выберите, с какой выполнить действие:
                  </p>
                  <div className="deal-action-picker__list">
                    {dealActionState.candidates.map((d) => {
                      const id = String(d.dealId)
                      const checked = String(dealActionState.selectedDealId || '') === id
                      return (
                        <label
                          key={id}
                          className={
                            'deal-action-picker__item' + (checked ? ' deal-action-picker__item--active' : '')
                          }
                        >
                          <input
                            type="radio"
                            name="deal-action-pick"
                            value={id}
                            checked={checked}
                            disabled={dealActionState.loading}
                            onChange={() =>
                              setDealActionState((prev) => ({ ...prev, selectedDealId: id, error: null }))
                            }
                          />
                          <span className="deal-action-picker__item-text">
                            <span className="deal-action-picker__item-title">
                              {d.itemTitle || 'Без названия'}
                            </span>
                            <span className="deal-action-picker__item-meta">
                              {getOrderStatusLabel(d.status) || 'Статус неизвестен'} · #{id.slice(0, 8)}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
              {dealActionState.error && (
                <p className="card-text card-text--error">{dealActionState.error}</p>
              )}
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                  marginTop: 16,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  className="lot-settings-btn lot-settings-btn--secondary"
                  onClick={closeDealActionModal}
                  disabled={dealActionState.loading}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className={
                    dealActionModal.kind === 'refund'
                      ? 'lot-settings-btn'
                      : 'deal-chat-row__command-btn'
                  }
                  style={
                    dealActionModal.kind === 'refund'
                      ? { backgroundColor: '#dc2626', borderColor: '#dc2626', color: '#fff' }
                      : undefined
                  }
                  onClick={handleDealActionConfirm}
                  disabled={
                    dealActionState.loading ||
                    (dealActionState.candidates.length > 1 && !dealActionState.selectedDealId)
                  }
                >
                  {dealActionState.loading
                    ? 'Выполняем…'
                    : dealActionModal.kind === 'refund'
                      ? 'Да, оформить возврат'
                      : 'Да, подтвердить'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

