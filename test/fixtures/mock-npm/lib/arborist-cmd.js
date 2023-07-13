/* Install extends this. Almost nothing of the actual is used by Install. */
const BaseCommand = require('./base-command')

class ArboristCmd extends BaseCommand {
  get isArboristCmd () {
    return true
  }

  static params = [
    'workspace',
    'workspaces',
    'include-workspace-root',
    'install-links',
  ]

  static workspaces = true
  static ignoreImplicitWorkspace = false

  async execWorkspaces (args) {
    return this.exec(args)
  }
}

module.exports = ArboristCmd
