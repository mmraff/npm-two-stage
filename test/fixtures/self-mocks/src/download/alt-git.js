/*
  TODO: (these are for coverage, and we don't necessarily have to do them for
  every download type!)
  * Need a function (not in the real thing) for configuring for a specific test
  * Need a case with dependencies, and one without
  * Need a case with devDependencies (and one without)
  * Need a case with peerDependencies (and one without)
  * Need a case with optionalDependencies (and one without)
  * Need a case with bundleDependencies (--> has dependencies section)
  * Need a case with _shrinkwrap property (amounts to an embedded package-lock.json)
*/
const npa = require('npm-package-arg')
const mockPacote = require('pacote')

const cache = {}

class  AltGitFetcher {
  constructor(spec, opts) {
    this.spec = npa(spec, opts.where)
    this.from = this.spec.saveSpec
  }
  manifest() {
    return mockPacote.manifest(this.spec.raw)
  }
}

AltGitFetcher.setTestConfig = function(data) {
  // TODO
}
module.exports = AltGitFetcher
