let allActionsStopped = false

function isAllActionsStopped() {
  return allActionsStopped
}

function stopAllActions() {
  allActionsStopped = true
}

function resumeAllActions() {
  allActionsStopped = false
}

module.exports = {
  isAllActionsStopped,
  stopAllActions,
  resumeAllActions,
}
