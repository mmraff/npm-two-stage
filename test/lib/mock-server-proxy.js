const arbFixtures = '../fixtures/arborist/fixtures'
const registryMock = require(arbFixtures + '/registry-mocks/server.js')

const INACTIVE = 0
const PENDING_START = 1
const STARTED = 2
let serverState = INACTIVE

let usersCount = 0

module.exports.start = () => {
  ++usersCount
  if (serverState == INACTIVE) {
    serverState = PENDING_START
    return registryMock.start()
    .then(result => {
      serverState = STARTED
      return result
    })
  }
  return Promise.resolve()
}

// If this process only sees one call of start(), then there will be
// no need to wait after the 1st call to stop()
module.exports.stop = (cb) => {
  if (!usersCount) return
  --usersCount
  if (!usersCount) {
    registryMock.server.close(function() {
      serverState = INACTIVE
      if (typeof cb === 'function') cb()
    })
  }
}

