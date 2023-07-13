/* N2SMOCK: MOCKED */
// This used to be the mock for npmlog, but that and proc-log became
// abstracted in npm v8 (now used by log-shim).
const messages = []
let showingProgress = true

function log(level, args) {
  messages.push({
    level,
    prefix: args[0],
    message: Object.values(args).slice(1).join(' ')
  })
}

module.exports = {
  level: 'verbose',
  error: function() { log('error', arguments) },
  warn: function() { log('warn', arguments) },
  info: function() { log('info', arguments) },
  verbose: function() { log('verbose', arguments) },
  silly: function() { log('silly', arguments) },
  clearProgress: () => { // used (only?) by npm.js
    showingProgress = false
  },
  showProgress: () => { // ditto
    showingProgress = true
  },
  progressIsShowing: () => showingProgress,
  getList: () => messages,
  purge: () => messages.splice(0)
}
