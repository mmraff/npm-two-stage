/* Install extends this. Almost nothing of the actual is used by Install. */

class ArboristCmd {
  constructor (npm) {
    // In the actual code, this class extends BaseCommand, which is the only
    // class in the lineage with a constructor. That constructor takes an
    // npm object and sets this.npm. We don't need BaseCommand.
    this.npm = npm
  }

  static params = [
    'workspace',
    'workspaces',
    'include-workspace-root',
    'install-links',
  ]
}

module.exports = ArboristCmd
