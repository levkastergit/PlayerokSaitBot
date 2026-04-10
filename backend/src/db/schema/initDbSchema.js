const { createUsersTable } = require('./createUsersTable')
const { createProductSettingsTable } = require('./createProductSettingsTable')
const { createTokensTable } = require('./createTokensTable')
const { createBumpHistoryTable } = require('./createBumpHistoryTable')
const { createSalesHistoryTable } = require('./createSalesHistoryTable')
const { createListingFeesTable } = require('./createListingFeesTable')
const { createActionsHistoryTable } = require('./createActionsHistoryTable')
const { createPartnersTable } = require('./createPartnersTable')
const { createChatSnapshotsTable } = require('./createChatSnapshotsTable')

function initDbSchema(db) {
  createUsersTable(db)
  createProductSettingsTable(db)
  createTokensTable(db)
  createBumpHistoryTable(db)
  createSalesHistoryTable(db)
  createListingFeesTable(db)
  createActionsHistoryTable(db)
  createPartnersTable(db)
  createChatSnapshotsTable(db)
}

module.exports = { initDbSchema }

