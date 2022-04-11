var isOffline = false

module.exports.limit = {
  // Straight from actual npm.js
  fetch: 10,
  action: 50
}

module.exports.config = {
  get(expr) {
    switch (expr) {
      case 'offline': return isOffline
    }
  },
  set(expr, val) {
    switch (expr) {
      case 'offline': if (typeof val == 'boolean') isOffline = val
    }
  }
}

