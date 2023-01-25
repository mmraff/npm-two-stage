/*
* this.npm.globalDir required, a path; globalTop will be resolved from it
* this.npm.config required, an object with a get() method
* a way to set things in npm.config: we will need to try different values, e.g. for 'global'
* this.npm.prefix required, a path: HOW TO GET THIS?
  - actual npm chooses its globalPrefix if global, else its localPrefix
  - in either case, it's obtained from corresponding field of config
  - WE MUST BE ABLE TO SET localPrefix ARTIFICIALLY, else we have to graft an
    aync procedure from actual Config class.
* this.npm.flatOptions?
* this.npm.log required
* for the offline cases, this.npm.config must have 'offline' and 'offline-dir'
*/

const { resolve, dirname } = require('path')
const Config = require('@npmcli/config')

module.exports = class {
  constructor ({
    cmd, // this one exists only in this mock
    cwd,
    config = {},
    flatOptions = {},
    log,
    prefix,
  }) {
    const cfgOpts = { ...config }
    if ('ignore-scripts' in cfgOpts) {
      cfgOpts.ignoreScripts = cfgOpts['ignore-scripts']
      delete cfgOpts['ignore-scripts']
    }
    if ('script-shell' in cfgOpts) {
      cfgOpts.scriptShell = cfgOpts['script-shell']
      delete cfgOpts['script-shell']
    }
    if ('offline-dir' in cfgOpts) {
      cfgOpts.offlineDir = cfgOpts['offline-dir']
      delete cfgOpts['offline-dir']
    }

    this.command = cmd
    this.log = log
    this.version = require('../package.json').version
    this.config = new Config({
      ...flatOptions,
      ...cfgOpts,
      cwd,
      log,
      npmPath: dirname(__dirname),
      prefix,
    })
    this.outputMsgs = []
  }

  get flatOptions () {
    const { flat } = this.config
    if (this.command)
      flat.npmCommand = this.command
    return flat
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

