const { sendJson } = require('./sendJson')
const { readJsonBody } = require('./readJsonBody')

const { handleAuthLogin } = require('../features/auth/handleAuthLogin')
const { handleAuthRegister } = require('../features/auth/handleAuthRegister')
const { handleAuthMe } = require('../features/auth/handleAuthMe')
const { handleAuthLogout } = require('../features/auth/handleAuthLogout')
const { handleAuthChangePassword } = require('../features/auth/handleAuthChangePassword')
const { handleGetToken } = require('../features/auth/handleGetToken')
const { handleSetToken } = require('../features/auth/handleSetToken')

const { handleGetProductSettings } = require('../features/productSettings/handleGetProductSettings')
const { handleGetProductSettingsList } = require('../features/productSettings/handleGetProductSettingsList')
const { handleCategoryCommandsList } = require('../features/productSettings/handleCategoryCommandsList')
const { handleCategoryCommandsUpsert } = require('../features/productSettings/handleCategoryCommandsUpsert')
const { handleUpsertProductSettings } = require('../features/productSettings/handleUpsertProductSettings')
const { handleDeleteProductSettings } = require('../features/productSettings/handleDeleteProductSettings')

const { handlePartnersInvite } = require('../features/partners/handlePartnersInvite')
const { handlePartnersDeleteInvite } = require('../features/partners/handlePartnersDeleteInvite')
const { handlePartnersGetOwnerList } = require('../features/partners/handlePartnersGetOwnerList')
const { handlePartnersGetWorkerList } = require('../features/partners/handlePartnersGetWorkerList')
const { handlePartnersConnect } = require('../features/partners/handlePartnersConnect')
const { handleGetOutboundIps } = require('../features/playerokOutboundIp/handleGetOutboundIps')
const { handleGetOutboundIpSettings } = require('../features/playerokOutboundIp/handleGetOutboundIpSettings')
const { handleSetOutboundIpSettings } = require('../features/playerokOutboundIp/handleSetOutboundIpSettings')
const { handleGetApprouteSettings } = require('../features/approute/handleGetApprouteSettings')
const { handleSetApprouteSettings } = require('../features/approute/handleSetApprouteSettings')
const { handleGetApprouteServices } = require('../features/approute/handleGetApprouteServices')
const { handleGetApprouteServiceVariants } = require('../features/approute/handleGetApprouteServiceVariants')
const { handleDockerBuildPush, getDockerBuildPushStatus } = require('../features/docker/handleDockerBuildPush')
const { handleDockerPullDeploy } = require('../features/docker/handleDockerPullDeploy')
const { isAllActionsStopped, stopAllActions, resumeAllActions } = require('../infra/runtimeControl')

function isLocalHostName(value) {
  const lower = String(value || '').toLowerCase()
  return lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('::1')
}

function isLocalUiRequest(req) {
  const origin = String(req?.headers?.origin || '')
  const host = String(req?.headers?.host || '')
  return isLocalHostName(origin) || isLocalHostName(host)
}

async function dispatchPublicAuth({ req, res, pathname, deps }) {
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }

    const result = await handleAuthLogin({ payload, deps })
    if (result.setCookie) res.setHeader('Set-Cookie', result.setCookie)
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }

    const result = await handleAuthRegister({ payload, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  return false
}

async function dispatchPrivateAuthAndSettings({ req, res, pathname, query, currentUserId, deps }) {
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const result = await handleAuthMe({
      req,
      deps,
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const result = await handleAuthLogout({ req, deps, res })
    if (result.setCookie) res.setHeader('Set-Cookie', result.setCookie)
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/change-password') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleAuthChangePassword({ req, payload, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/token') {
    const result = await handleGetToken({ currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/token') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleSetToken({ payload, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/product-settings') {
    const result = await handleGetProductSettings({ query, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/product-settings/list') {
    const result = await handleGetProductSettingsList({ query, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/category-commands/list') {
    const result = await handleCategoryCommandsList({ query, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/category-commands') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleCategoryCommandsUpsert({ payload, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/product-settings') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleUpsertProductSettings({ payload, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/product-settings/delete') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleDeleteProductSettings({ payload, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/partners/owner') {
    const result = await handlePartnersGetOwnerList({ deps, currentUserId })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/partners/worker') {
    const result = await handlePartnersGetWorkerList({ deps, currentUserId })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/partners/invite') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handlePartnersInvite({ payload, deps, currentUserId })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/partners/invite/delete') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handlePartnersDeleteInvite({ payload, deps, currentUserId })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/partners/connect') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handlePartnersConnect({ payload, deps, currentUserId })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/playerok/outbound-ips') {
    const result = await handleGetOutboundIps()
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/playerok/outbound-ip-settings') {
    const result = await handleGetOutboundIpSettings({ currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/outbound-ip-settings') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleSetOutboundIpSettings({ payload, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/approute/settings') {
    const result = await handleGetApprouteSettings({ currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/approute/settings') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleSetApprouteSettings({ payload, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/approute/services') {
    const result = await handleGetApprouteServices({ currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/runtime/actions-state') {
    sendJson(res, 200, { ok: true, stopped: isAllActionsStopped() })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/runtime/actions/stop') {
    stopAllActions()
    sendJson(res, 200, { ok: true, stopped: true })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/runtime/actions/resume') {
    resumeAllActions()
    sendJson(res, 200, { ok: true, stopped: false })
    return true
  }

  if (req.method === 'GET' && pathname === '/api/docker/build-push/status') {
    if (!isLocalUiRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'Доступно только с localhost' })
      return true
    }
    sendJson(res, 200, getDockerBuildPushStatus())
    return true
  }

  if (req.method === 'POST' && pathname === '/api/docker/build-push') {
    if (!isLocalUiRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'Доступно только с localhost' })
      return true
    }
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleDockerBuildPush({ payload })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/docker/pull-deploy') {
    if (isLocalUiRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'Доступно только на проде' })
      return true
    }
    const result = await handleDockerPullDeploy()
    sendJson(res, result.statusCode, result.data)
    return true
  }

  const approuteVariantsMatch = pathname.match(/^\/api\/approute\/services\/([^/]+)\/variants$/)
  if (req.method === 'GET' && approuteVariantsMatch) {
    const serviceId = decodeURIComponent(approuteVariantsMatch[1])
    const result = await handleGetApprouteServiceVariants({ serviceId, currentUserId, deps })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  return false
}

module.exports = { dispatchPublicAuth, dispatchPrivateAuthAndSettings }

