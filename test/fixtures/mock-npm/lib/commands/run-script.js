// This is used by npm_test

const BaseCommand = require('../base-command.js')
class RunScript extends BaseCommand {
  static description = 'Run arbitrary package scripts'
  static params = [
    'workspace',
    'workspaces',
    'include-workspace-root',
    'if-present',
    'ignore-scripts',
    'foreground-scripts',
    'script-shell',
  ]

  static name = 'run-script'
  static usage = ['<command> [-- <args>]']
  static workspaces = true
  static ignoreImplicitWorkspace = false
  static isShellout = true

  async exec (args) {
process.emit('used', 'mock run-script command: exec()')
    if (args.length) {
      return Promise.resolve()
    } else {
      return Promise.resolve([])
    }
  }
}

module.exports = RunScript
