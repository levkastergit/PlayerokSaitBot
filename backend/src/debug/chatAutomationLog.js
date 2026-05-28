'use strict'

/** @typedef {{ ts: number, type: string, chatId: string|null, dealId: string|null, outcome: string, reason: string|null, details: object|null }} ChatAutomationEvent */

function buildEvent({ type, chatId, dealId, outcome, reason, details }) {
  return {
    ts: Date.now(),
    type: String(type || 'unknown'),
    chatId: chatId != null ? String(chatId) : null,
    dealId: dealId != null ? String(dealId) : null,
    outcome: String(outcome || 'unknown'),
    reason: reason != null ? String(reason) : null,
    details: details && typeof details === 'object' ? details : null,
  }
}

function buildAutomessageEvent({ logLabel, chatId, dealId, result }) {
  const sent = Boolean(result && result.sent)
  const reason = (result && result.reason) || null
  let outcome = 'skipped'
  if (sent) outcome = 'sent'
  else if (reason === 'send_failed') outcome = 'error'

  return buildEvent({
    type: logLabel || 'automessage',
    chatId,
    dealId,
    outcome,
    reason,
    details: {
      kind: result && result.kind ? result.kind : null,
    },
  })
}

function buildSupercellFlowEvent({ chatId, dealId, flowResult, flowState }) {
  if (!flowResult || typeof flowResult !== 'object') {
    return buildEvent({
      type: 'supercell_flow',
      chatId,
      dealId,
      outcome: 'skipped',
      reason: 'no_result',
      details: null,
    })
  }

  const action = String(flowResult.action || 'unknown')
  let outcome = 'skipped'
  if (action === 'code_requested' || action === 'invalid_email_sent') outcome = 'sent'
  if (action === 'error') outcome = 'error'

  return buildEvent({
    type: 'supercell_flow',
    chatId,
    dealId: dealId || flowState?.dealId || flowResult.dealId || null,
    outcome,
    reason: flowResult.reason || null,
    details: {
      action,
      category: flowResult.category || flowState?.category || null,
      gameKey: flowResult.gameKey || null,
      requestCodeRequested: Boolean(flowState?.requestCodeRequested),
      flowActive: Boolean(flowState?.active),
    },
  })
}

function buildSupercellFlowCheckEvent({ chatId, dealId, flowState, itemCategory, hasBuyerEmail }) {
  if (!flowState) {
    return buildEvent({
      type: 'supercell_flow_check',
      chatId,
      dealId,
      outcome: 'skipped',
      reason: 'no_flow_state',
      details: { hasBuyerEmail: Boolean(hasBuyerEmail), itemCategory: itemCategory || null },
    })
  }
  if (!flowState.active) {
    return buildEvent({
      type: 'supercell_flow_check',
      chatId,
      dealId: dealId || flowState.dealId || null,
      outcome: 'skipped',
      reason: 'flow_inactive',
      details: {
        category: flowState.category || null,
        requestCodeRequested: Boolean(flowState.requestCodeRequested),
      },
    })
  }
  return buildEvent({
    type: 'supercell_flow_check',
    chatId,
    dealId: dealId || flowState.dealId || null,
    outcome: 'triggered',
    reason: null,
    details: {
      category: flowState.category || null,
      itemCategory: itemCategory || null,
      hasBuyerEmail: Boolean(hasBuyerEmail),
    },
  })
}

module.exports = {
  buildAutomessageEvent,
  buildSupercellFlowEvent,
  buildSupercellFlowCheckEvent,
}
