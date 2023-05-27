/*
  TODO: say something here
*/

const { resolve, dirname } = require('path')
const Config = require('@npmcli/config')

module.exports = class {
  // NOTE: actual npm is instantiated (in cli.js) with *no arguments*!
  // Also, npm.exec is passed 2 args: cmd and npm.argv
  constructor ({ // NOTE arguments only exist in this mock!
    args = {},
    cmd,
    cwd,
    env = {},
  }) {
    if (!cmd) {
      throw new Error('Mock npm: command must be identified in cmd property!')
    }
    const filteredEnv = {}
    if ('PREFIX' in env) {
      filteredEnv.PREFIX = env.PREFIX
    }
    if ('DESTDIR' in env) {
      filteredEnv.DESTDIR = env.DESTDIR
    }
    this.command = cmd
    this.version = require('../package.json').version
    this.config = new Config({
      args,
      cwd,
      env: filteredEnv,
      npmPath: dirname(__dirname),
    })
    // In the real thing, config.load is called by the async npm.load method:
    this.config.load()

    this.outputMsgs = []
  }

  get flatOptions () { // VERBATIM
    const { flat } = this.config
    if (this.command) {
      flat.npmCommand = this.command
    }
    return flat
  }

  get global () { // VERBATIM
    return this.config.get('global') || this.config.get('location') === 'global'
  }

  get globalPrefix () {
    return this.config.globalPrefix
  }

  get localPrefix () {
    return this.config.localPrefix
  }

  get prefix () {
    return this.config.get('global') ? this.globalPrefix : this.localPrefix
  }

  get globalDir () {
    return process.platform !== 'win32'
      ? resolve(this.globalPrefix, 'lib', 'node_modules')
      : resolve(this.globalPrefix, 'node_modules')
  }

  output (...msg) {
    this.outputMsgs.push(msg.join(' '))
    // To get, reference this.outputMsgs.
    // To purge, call this.outputMsgs.splice(0).
  }
}

