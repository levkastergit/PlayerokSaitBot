'use strict'

function createProductSettingsKeyFns({ CATEGORY_SETTINGS_PREFIX, GROUP_SETTINGS_PREFIX }) {
  return {
    getCategorySettingsKey(category) {
      const name = String(category || '').trim()
      return `${CATEGORY_SETTINGS_PREFIX}${name}`
    },
    getGroupSettingsKey(label) {
      const name = String(label || '').trim()
      return name ? `${GROUP_SETTINGS_PREFIX}${name}` : ''
    },
  }
}

module.exports = { createProductSettingsKeyFns }

