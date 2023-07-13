// This is used by npm_test.
// Mock ArboristWorkspaceCmd extends this.
// Download extends this. Almost nothing of the actual is used by Download.

class BaseCommand {
  static get describeUsage () {
    return 'I am the generic usage string in mock BaseCommand'
  }

  constructor (npm) {
    this.npm = npm
  }

  async cmdExec (args) {  // Needed for npm_test
    const { config } = this.npm

    if (config.get('usage')) {
process.emit('used', 'mock base-command: cmdExec() with "usage" set')
      return this.npm.output(this.usage)
    }

    return this.exec(args)
  }

  get name () {  // Needed for npm_test
    return this.constructor.name
  }

  get description () { // TODO: find out if ever called
process.emit('used', 'mock base-command: get description()')
    return this.constructor.description
  }

  get params () { // TODO: find out if ever called
process.emit('used', 'mock base-command: get params()')
    return this.constructor.params
  }

  get usage () {
    return this.constructor.describeUsage
  }
}
module.exports = BaseCommand

