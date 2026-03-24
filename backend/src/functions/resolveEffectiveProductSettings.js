'use strict'

const { normalizeProductKey } = require('./keyUtils')

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
      if (row?.settings) {
        effectiveSettings = JSON.parse(row.settings)
        const label =
          effectiveSettings && typeof effectiveSettings.settingsLabel === 'string'
            ? effectiveSettings.settingsLabel.trim()
            : ''

        if (label) {
          const groupKey = getGroupSettingsKey(label)
          const groupRow = getSettings.get(userId, groupKey)
          if (groupRow?.settings) {
            effectiveSettings = JSON.parse(groupRow.settings)
            effectiveKey = groupKey
          }
        }
      }
    } catch (_) {
      effectiveSettings = null
    }

    return { effectiveSettings, effectiveKey }
  }
}

module.exports = { createResolveEffectiveProductSettings }

