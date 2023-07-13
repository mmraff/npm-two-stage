// This is used by npm_test

const ArboristWorkspaceCmd = require('../arborist-cmd.js')

class LL extends ArboristWorkspaceCmd {
  static name = 'll'
  static usage = ['[[<@scope>/]<pkg> ...]']

  async exec (args) {
process.emit('used', 'mock ll command: exec()')
    this.npm.config.set('long', true)
    return Promise.resolve()
  }
}

module.exports = LL
