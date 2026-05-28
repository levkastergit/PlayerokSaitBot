'use strict'

const { normalizeProductKey } = require('./keyUtils')
const { mergeProductSettings } = require('./mergeProductSettings')

function createResolveEffectiveProductSettings({ getSettings, getGroupSettingsKey }) {
  if (!getSettings || typeof getSettings.get !== 'function') {
    throw new Error('getSettings with .get(key) is required')
  }
  if (!getGroupSettingsKey || typeof getGroupSettingsKey !== 'function') {
    throw new Error('getGroupSettingsKey is required')
  }

  return function resolveEffectiveProductSettings(userId, productKey) {
    const normalizedKey = normalizeProductKey(productKey)
    if (!normalizedKey) {
      return { effectiveSettings: null, effectiveKey: '' }
    }

    let effectiveSettings = null
    let effectiveKey = normalizedKey

    try {
      const row = getSettings.get(userId, normalizedKey)
      let itemSettings = null
      if (row?.settings) {
        itemSettings = JSON.parse(row.settings)
        effectiveKey = normalizedKey
      }

      const label =
        itemSettings && typeof itemSettings.settingsLabel === 'string'
          ? itemSettings.settingsLabel.trim()
          : ''

      let groupSettings = null
      if (label) {
        const groupKey = getGroupSettingsKey(label)
        const groupRow = getSettings.get(userId, groupKey)
        if (groupRow?.settings) {
          groupSettings = JSON.parse(groupRow.settings)
          effectiveKey = groupKey
        }
      }

      if (itemSettings || groupSettings) {
        effectiveSettings = mergeProductSettings(groupSettings, itemSettings)
      }
    } catch (_) {
      effectiveSettings = null
    }

    return { effectiveSettings, effectiveKey }
  }
}

module.exports = { createResolveEffectiveProductSettings }

