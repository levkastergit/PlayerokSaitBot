'use strict'

const { getSpeedSettingsForUi } = require('../../infra/playerokSpeedSettings')

// Возвращает метаданные параметров скорости/задержек (для UI) + текущие явно заданные значения.
// defs: [{ key, labelRu, hintRu, group, min, max, default }], values: { key: number } (пусто = дефолт).
async function handleGetSpeedSettings() {
  const { defs, values } = getSpeedSettingsForUi()
  return {
    statusCode: 200,
    data: { ok: true, defs, values },
  }
}

module.exports = { handleGetSpeedSettings }
