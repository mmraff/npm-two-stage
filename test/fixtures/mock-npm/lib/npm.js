const configData = {
  offline: false
}

// There is no tmp property here because we will set that in the test suite
// where it's needed (but must do that before download.js requires it)

module.exports.limit = {
  // Straight from actual npm.js
  fetch: 10,
  action: 50
}

module.exports.config = {
  get(expr) { return configData[expr] },
  set(expr, val) {
    switch (expr) {
      case 'offline':
      case 'no-optional':
      case 'no-shrinkwrap':
        if (typeof val == 'boolean') configData[expr] = val
        else if (val == null) configData[expr] = false
        break
      default:
        configData[expr] = val
    }
  }
}

