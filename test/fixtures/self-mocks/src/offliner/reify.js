/* Another huge file */
module.exports = cls => class Reifier extends cls {
  constructor (options) {
    super(options)

    const {
      savePrefix = '^',
      packageLockOnly = false,
      dryRun = false,
      formatPackageLock = true,
    } = options
  }

  /* This is called in install.js, so we must mock it */
  // public method
  async reify (options = {}) {
    /* yada yada... then...
      treeCheck returns what you pass it, unless in debug mode: */
    //return treeCheck(this.actualTree)
    return this.actualTree
  }
}
