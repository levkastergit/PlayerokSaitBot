'use strict'

const { AsyncLocalStorage } = require('async_hooks')

const playerokRequestStorage = new AsyncLocalStorage()

function runWithPlayerokUser(userId, fn) {
  const uid = Number(userId)
  const store = { userId: Number.isFinite(uid) && uid > 0 ? uid : null }
  return playerokRequestStorage.run(store, fn)
}

function getPlayerokRequestUserId() {
  const store = playerokRequestStorage.getStore()
  if (!store) return null
  return store.userId != null ? store.userId : null
}

module.exports = {
  runWithPlayerokUser,
  getPlayerokRequestUserId,
}
