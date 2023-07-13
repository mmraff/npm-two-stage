// This is used by npm_test

const BaseCommand = require('../base-command.js')
class Config extends BaseCommand {
  static description = 'Manage the npm configuration files'
  static name = 'config'
  static usage = [
    'set <key>=<value> [<key>=<value> ...]',
    'get [<key> [<key> ...]]',
    'delete <key> [<key> ...]',
    'list [--json]',
    'edit',
    'fix',
  ]

  static params = [
    'json',
    'global',
    'editor',
    'location',
    'long',
  ]

  async exec ([action, ...args]) {
process.emit('used', 'mock config command: exec()')
    return Promise.resolve()
  }
}

module.exports = Config
