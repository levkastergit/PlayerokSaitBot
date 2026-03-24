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

  return false
}

module.exports = { dispatchPublicAuth, dispatchPrivateAuthAndSettings }

