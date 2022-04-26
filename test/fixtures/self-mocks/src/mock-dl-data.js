const testSpecs = {
  git: {
    'ghUser/ghProject#0123456789abcdef0123456789abcdef01234567': 'github.com%2FghUser%2FghProject%230123456789abcdef0123456789abcdef01234567.tar.gz',
    'git://generic-githost.com/SomeUser/example.git#0123456789abcdef0123456789abcdef01234567': 'generic-githost.com%2FSomeUser%2Fexample%230123456789abcdef0123456789abcdef01234567.tar.gz',
    'git://bitbucket.org/someuser/some-project.git#abcdef0123456789abcdef0123456789abcdef01': '/tmp/npm_234756/_git-offline/bitbucket_org_someuser_some-project_2d7e5f/package.tgz'
  },
  remote: {
    'https://example.com/someuser/example/archive/5559999.tgz': 'example.com%2Fsomeuser%2Fexample%2Farchive%2F5559999.tgz'
  },
  version: {
    'dummy-pkg@1.2.3': 'dummy-pkg-1.2.3.tar.gz'
  },
  range: {
    'dummy-pkg@>=1': 'dummy-pkg-1.2.3.tar.gz'
  },
  tag: {
    'dummy-pkg': 'dummy-pkg-1.2.3.tar.gz',
    'dummy-pkg@beta-9': 'dummy-pkg-0.1.2.tar.gz'
  }
}
let dlDir = 'road/to/nowhere'

module.exports = {
  get path() { return dlDir },
  set path(val) { if (val && typeof val == 'string') dlDir = val },
  getSpec: function(type, index) {
    if (type in testSpecs) {
      const items = Object.keys(testSpecs[type])
      const idx = (index && typeof index == 'number') ? index % items.length : 0
      return items[idx]
    }
    throw new Error(`Offliner unhandled spec type "${dep.type}" ${dep.raw}`)
  },
  getFilename: function(dep) { // NOTE: MUST GIVE AN NPA() RESULT TO THIS!!!
    if (dep.type in testSpecs)
      return testSpecs[dep.type][dep.raw]

    throw new Error(`Offliner unhandled spec type "${dep.type}" ${dep.raw}`)
  }
}
