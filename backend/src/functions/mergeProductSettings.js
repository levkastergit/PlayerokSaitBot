'use strict'

function mergeAutodeliveryApi(itemApi, groupApi) {
  const item = itemApi && typeof itemApi === 'object' ? itemApi : null
  const group = groupApi && typeof groupApi === 'object' ? groupApi : null
  if (!item && !group) return null
  const merged = { ...(group || {}), ...(item || {}) }
  merged.enabled = Boolean(item?.enabled || group?.enabled)
  return merged
}

/** @deprecated use mergeAutodeliveryApi */
function pickAutodeliveryApi(itemApi, groupApi) {
  return mergeAutodeliveryApi(itemApi, groupApi)
}

function mergeProductSettings(groupSettings, itemSettings) {
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

  const api = mergeAutodeliveryApi(itemSettings.autodeliveryApi, groupSettings.autodeliveryApi)
  if (api) merged.autodeliveryApi = api

  const topupApi = mergeAutodeliveryApi(itemSettings.autotopupApi, groupSettings.autotopupApi)
  if (topupApi) merged.autotopupApi = topupApi

  return merged
}

module.exports = { mergeProductSettings, mergeAutodeliveryApi, pickAutodeliveryApi }
