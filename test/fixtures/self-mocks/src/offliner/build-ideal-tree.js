/* Another huge one in the actual file */
module.exports = cls => class IdealTreeBuilder extends cls {
  constructor (options) {
    super(options)

    // normalize trailing slash
    const registry = options.registry || 'https://registry.npmjs.org'
    options.registry = this.registry = registry.replace(/\/+$/, '') + '/'

    const {
      idealTree = null,
      global = false,
      follow = false,
      globalStyle = false,
      legacyPeerDeps = false,
      force = false,
      packageLock = true,
      strictPeerDeps = false,
      workspaces = [],
    } = options
  }
}
