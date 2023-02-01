const { promisify } = require('util')

const rimrafAsync = promisify(require('rimraf'))
const npa = require('npm-package-arg')
const tap = require('tap')

const makeAssets = require('./lib/make-assets')

const testSpecs = {
  version: [
    {
      spec: 'dummy1@1.0.0',
      manifest: {
        name: 'dummy1',
        version: '1.0.0',
        _from: 'dummy1@1.0.0',
        _resolved: 'https://registry.mock.com/dummy1/-/dummy1-1.0.0.tgz'
      }
    },
    {
      spec: 'dummy2@1.2.3',
      manifest: {
        name: 'dummy2',
        version: '1.2.3',
        _from: 'dummy2@1.2.3',
        _resolved: 'https://registry.mock.com/dummy2/-/dummy2-1.2.3.tgz'
      }
    }
  ],
  range: [
    {
      spec: 'dummy3@^2',
      manifest: {
        name: 'dummy3',
        version: '2.1.0',
        _from: 'dummy3@^2',
        _resolved: 'https://registry.mock.com/dummy3/-/dummy3-2.1.0.tgz'
      }
    }
  ],
  tag: [
    {
      spec: 'dummy4@lightyear',
      manifest: {
        name: 'dummy4',
        version: '3.2.1',
        _from: 'dummy4@lightyear',
        _resolved: 'https://registry.mock.com/dummy4/-/dummy4-3.2.1.tgz'
      }
    }
  ],
  remote: [
    {
      spec: 'https://gitbox.com/groupname/gbproject/archive/v3.2.1.tar.gz',
      manifest: {
        name: 'gbproject',
        _resolved: 'https://gitbox.com/groupname/gbproject/archive/v3.2.1.tar.gz'
      }
    },
    {
      spec: 'https://defunct.com/old-home-of-project/ultimate.tar.gz',
      manifest: {
        name: 'gbproject',
        _resolved: 'https://gitbox.com/groupname/gbproject/archive/v3.2.1.tar.gz'
      }
    }
  ],
  git: [
    {
      spec: 'bitbucket:someuser/someproject',
      manifest: {
        _resolved: 'git+ssh://git@bitbucket.org/someuser/someproject.git#1234567890abcdef1234567890abcdef12345678',
        _from: 'bitbucket:someuser/someproject',
        _sha: '1234567890abcdef1234567890abcdef12345678',
        _allRefs: [ 'v0.1.2' ]
      }
    },
    {
      spec: 'git://bitbucket.org/someuser/someproject.git',
      manifest: {
        _resolved: 'git+ssh://git@bitbucket.org/someuser/someproject.git#1234567890abcdef1234567890abcdef12345678',
        _from: 'git://bitbucket.org/someuser/someproject.git',
        _sha: '1234567890abcdef1234567890abcdef12345678',
        _allRefs: [ 'v0.1.2' ]
      }
    },
    { // to simulate a redirect
      spec: 'git://defunct.com/someuser/someproject.git',
      manifest: {
        _resolved: 'git+ssh://git@bitbucket.org/someuser/someproject.git#1234567890abcdef1234567890abcdef12345678',
        _from: 'git://defunct.com/someuser/someproject.git',
        _sha: '1234567890abcdef1234567890abcdef12345678',
        _allRefs: [ 'v0.1.2' ]
      }
    },
    {
      spec: 'git://wherever.com/someuser/someproject.git',
      manifest: {
        _resolved: 'git://wherever.com/someuser/someproject.git#1234567890abcdef1234567890abcdef12345678',
        _from: 'git://wherever.com/someuser/someproject.git',
        _sha: '1234567890abcdef1234567890abcdef12345678',
        _allRefs: [ 'master' ]
      }
    }
  ]
}

let counter = 0
function createDependencyTestConfig(parentItem, depItem, depCategory) {
  const dependencyProp =
    depCategory ? depCategory + 'Dependencies' : 'dependencies'
  const depNpaSpec = npa(depItem.spec)
  const depsObject = {}
  switch (depNpaSpec.type) {
    case 'version':
      Object.assign(
        depsObject, { [depItem.manifest.name]: depItem.manifest.version }
      )
      break
    default:
      throw new Error('Unhandled spec type in createDependencyTestConfig')
  }
  return {
    spec: parentItem.spec,
    manifest: Object.assign(
      {
        [dependencyProp]: depsObject,
        test: ++counter
      },
      parentItem.manifest
    )
  }
}

function createShrinkwrapTestConfig(parentItem, depItem, depCategory) {
  const basicCfg = createDependencyTestConfig(parentItem, depItem, depCategory)
  const manifest = basicCfg.manifest
  manifest._shrinkwrap = {}
  const shrinkwrapDeps = {}
  const dependencyProp =
    depCategory ? depCategory + 'Dependencies' : 'dependencies'
  for (let name in manifest[dependencyProp]) {
    shrinkwrapDeps[name] = { version: manifest[dependencyProp][name] }
    switch (depCategory) {
      case 'dev':
      case 'optional':
        shrinkwrapDeps[name][depCategory] = true
        break
    }
  }
  manifest._shrinkwrap.dependencies = shrinkwrapDeps
  return basicCfg
}

let mockDlt
let gitTrackerKeys
let itemAgents
let mockLog
let mockPacote
let npf

tap.before(() =>
  makeAssets('tempAssets1', 'download/item-agents.js')
  .then(assets => {
    gitTrackerKeys = require(assets.libDownload + '/git-tracker-keys')
    itemAgents = require(assets.libDownload + '/item-agents.js')
    npf = require(assets.libDownload + '/npm-package-filename')
    mockDlt = require(assets.libDownload + '/dltracker')
    mockLog = require(assets.nodeModules + '/npmlog') // TODO: might not be needed
    mockPacote = require(assets.nodeModules + '/pacote')

    tap.teardown(() => rimrafAsync(assets.fs('rootName')))
  })
)

/*
  100% coverage is achieved by a range of calls to handleItem, because that
  calls the other two exports (while processDependencies also calls the other
  two exports); but explicit tests of xformResult allow us direct inspection.
*/

const makeOpts = (pkgDir) =>  ({
  dlTracker: mockDlt.createSync(pkgDir), // TODO: add this function to mock dltracker
  flatOpts: {},
  cmd: {}
})
  /*
    NOTES:
    * item-agents makes no use of the log, and no mention of the cache,
      though they are passed in opts to other services (e.g., pacote)
    * it makes explicit mention of opts.flatOpts, but an empty object should suffice
    * it makes explicit mention of opts.dlTracker, *and* the ItemAgents use it!
      (contains(), add(), and path)
    * it uses opts.cmd fields: includeDev, includePeer, noShrinkwrap, noOptional
    * createAgent() (called by handleItem) uses opts.where
  */

function expectDlTrackerData(t, dlTracker, type, keyData, msg) {
  const expected = {}
  switch (type) {
    case 'tag':
      Object.assign(expected, { spec: keyData.spec } )
      // fallthrough intentional
    case 'semver':
      Object.assign(expected, {
        name: keyData.name, version: keyData.version,
        filename: npf.makeTarballName({
          type: 'semver', name: keyData.name, version: keyData.version
        })
      })
      break
    case 'git':
      const domain = keyData.name.replace(/\/.+$/, '')
      const hostedPath = keyData.name.replace(/^[^/]+\//, '')
      Object.assign(expected, {
        repo: keyData.name, commit: keyData.spec,
        filename: npf.makeTarballName({
          type: 'git', domain, path: hostedPath, commit: keyData.spec
        })
      })
      break
    case 'url':
      Object.assign(expected, {
        spec: keyData.spec,
        filename: npf.makeTarballName({
          type: 'url', url: keyData.spec
        })
      })
      break
  }
  const actual = dlTracker.getData(
    type, keyData.name, keyData.spec || keyData.version
  )
  t.has(actual, expected, msg)
  return actual
}

tap.test('xformResult', t1 => {
  t1.throws(() => itemAgents.xformResult()) // needs an array at least
  t1.throws(() => itemAgents.xformResult({}))

  let output = itemAgents.xformResult([ [ { smoke: 1 } ], [ { smoke: 2 } ] ])
  t1.strictSame(output, [ { smoke: 1 }, { smoke: 2 } ])

  output = itemAgents.xformResult([ [ { smoke: 1 } ], { smoke: 2 } ])
  t1.strictSame(output, [ { smoke: 1 }, { smoke: 2 } ])

  // deeper nesting is resolved by running the results through a corresponding
  // number of xformResult calls
  output = itemAgents.xformResult([
    [ { smoke: 1 } ], [[ { smoke: 2 } ], { smoke: 3 } ]
  ])
  output = itemAgents.xformResult(output)
  t1.strictSame(output, [ { smoke: 1 }, { smoke: 2 }, { smoke: 3 } ])

  t1.end()
})

tap.test('handleItem', t1 => {
  const versionData0 = testSpecs.version[0]
  t1.test('given a semver package spec not known to the registry', t2 => {
    const opts = makeOpts()
    opts.topLevel = true
    mockPacote.setTestConfig(null)
    t2.rejects(() => itemAgents.handleItem('dummy0@99.99.99', opts))
    t2.end()
  })
  t1.test('given a package spec of unhandled type', t2 => {
    const opts = makeOpts()
    opts.topLevel = true
    t2.rejects(() => itemAgents.handleItem('must/be/a/directory', opts))
    t2.end()
  })
  t1.test('given a known registry package spec', t2 => {
  /*
    TODO: this chain of tests expects to use the same dlTracker, so we must
    somehow get the initial dlTracker and ensure that it goes into the opts
    each time (or just delete the topLevel flag after 1st use?)
  */
    const opts = makeOpts()
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest
    })
    // Simulate a delay in the response from pacote.manifest, so that we have
    // time to put in a duplicate request:
    mockPacote.setWait('manifest', versionData0.spec)
    const p1 = itemAgents.handleItem(
      versionData0.spec, { ...opts, topLevel: true }
    )
    // Make a 2nd request for same thing:
    itemAgents.handleItem(versionData0.spec, opts)
    .then(res => {
      mockPacote.setWait('tarball', versionData0.spec)
      mockPacote.endWait('manifest', versionData0.spec)
      // Coverage: this is a different case of duplicate than below
      t2.strictSame(
        res, [{
          spec: versionData0.spec,
          name: versionData0.manifest.name,
          duplicate: true
        }],
        'request for same spec in same session should be flagged as a duplicate'
      )
    })
    .then(() => {
      // This results in a 'latest' request
      const plainSpec = versionData0.spec.replace(/@.*$/, '')
      const defaultManifest = Object.assign({}, versionData0.manifest)
      defaultManifest._from = plainSpec
      mockPacote.setTestConfig({ [plainSpec]: defaultManifest })
      itemAgents.handleItem(plainSpec, opts)
      .then(res => {
        mockPacote.endWait('tarball', versionData0.spec)
        t2.strictSame(
          res,
          [{ spec: plainSpec, name: plainSpec, duplicate: true }],
          'request that evaluates to same spec in same session should be flagged as a duplicate'
        )
      })
    })
    .then(() => {
      // This implicitly results in a 'latest' request
      const anySpec = versionData0.spec.replace(/@.*$/, '@*')
      const defaultManifest = Object.assign({}, versionData0.manifest)
      defaultManifest._from = anySpec
      mockPacote.setTestConfig({ [anySpec]: defaultManifest })
      itemAgents.handleItem(anySpec, opts)
      .then(res => {
        t2.strictSame(
          res,
          [{ spec: anySpec, name: versionData0.manifest.name, duplicate: true }],
          'request that evaluates to same spec in same session should be flagged as a duplicate'
        )
      })
    })
    .then(() =>
      p1.then(res => {
        t2.strictSame(
          res,
          [{ spec: versionData0.spec, name: versionData0.manifest.name }],
          'first request should not be marked duplicate'
        )
        const pkg = versionData0.manifest
        expectDlTrackerData(
          t2, opts.dlTracker,
          'semver', { name: pkg.name, version: pkg.version },
          'Semver version package data should be stored as expected'
        )
      })
    )
    .then(() => {
      // Coverage: this is a different case of duplicate than above -
      // not necessarily in same session
      itemAgents.handleItem(versionData0.spec, opts)
      .then(res => {
        t2.strictSame(
          res,
          [{ spec: versionData0.spec, name: versionData0.manifest.name, duplicate: true }],
          'request for package already downloaded should be flagged as a duplicate'
        )
        t2.end()
      })
    })
  })
  t1.test('git repo spec that makes gitTrackerKeys throw', t2 => {
    const spec = 'git://!@#$%^&*'
    t2.rejects(() => itemAgents.handleItem(spec, makeOpts()), /Invalid URL/)
    t2.end()
  })
  t1.test('rejects when an invalid manifest is fetched', t2 => {
    const badManifest = Object.assign({}, versionData0.manifest)
    const opts = makeOpts()
    badManifest._resolved = undefined
    mockPacote.setTestConfig({ [versionData0.spec]: badManifest })
    t2.rejects(
      () => itemAgents.handleItem(versionData0.spec, opts),
      /No _resolved value/
    )
    .then(() => {
      badManifest._resolved = true
      mockPacote.setTestConfig({ [versionData0.spec]: badManifest })
      t2.rejects(
        () => itemAgents.handleItem(versionData0.spec, opts),
        /Invalid _resolved value/
      )
      .then(() => {
        // A real edgy edge case - just about anything else sketchy gets
        // interpreted as something that looks meaningful, or throws a
        // TypeError 'Invalid URL':
        badManifest._resolved = 'file:///'
        mockPacote.setTestConfig({ [versionData0.spec]: badManifest })
        t2.rejects(
          () => itemAgents.handleItem(versionData0.spec, opts),
          /Unable to parse meaningful data/
        )
        t2.end()
      })
    })
  })
  t1.test('given spec of a known registry package by tag', t2 => {
    const testData = testSpecs.tag[0]
    const opts = makeOpts()
    mockPacote.setTestConfig({ [testData.spec]: testData.manifest })
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [{ spec: testData.spec, name: testData.manifest.name }],
        'request gets corresponding non-duplicate result'
      )
      const tagName = testData.spec.replace(/^[^@]+@/, '') // would not be enough for a scoped spec...
      const pkg = testData.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'tag', { name: pkg.name, spec: tagName, version: pkg.version },
        'Tag spec package data should be stored as expected'
      )
      t2.end()
    })
  })
  t1.test('given spec of a known registry package by version range', t2 => {
    const testData = testSpecs.range[0]
    const opts = makeOpts()
    mockPacote.setTestConfig({ [testData.spec]: testData.manifest })
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [{ spec: testData.spec, name: testData.manifest.name }],
        'request gets corresponding non-duplicate result'
      )
      /*
        Our mock dltracker does not have the ability to correctly answer a
        query on a range spec; but we can fetch the data of the specific
        version that we expect, and that will imply that handleItem had the
        correct side effect.
      */
      const pkg = testData.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'Semver range spec package data should be stored as expected'
      )
      t2.end()
    })
  })

  t1.test('specified package has regular dependencies', t2 => {
    const testData = createDependencyTestConfig(testSpecs.version[1], versionData0)
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    let opts = makeOpts()
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, name: versionData0.manifest.name },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its dependency'
      )
      let pkg = testData.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )

      pkg = versionData0.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for the dependency are in the dlTracker data'
      )

      opts = makeOpts()
      testData.manifest.bundledDependencies = [ versionData0.manifest.name ]
      return itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    })
    .then(res => {
      let pkg = testData.manifest
      let depPkg = versionData0.manifest
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and not its bundled dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'bundled dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('package has only regular dependencies, but a dep fetch fails', t2 => {
    const testData = createDependencyTestConfig(testSpecs.version[1], versionData0)
    mockPacote.setTestConfig({
      [testData.spec]: testData.manifest
    })
    t2.rejects(() => itemAgents.handleItem(testData.spec, makeOpts()))
    // For coverage. The error is a generic 'Unknown package' from our
    // mock pacote, but its nature doesn't really matter here.
    t2.end()
  })
  t1.test('The package has devDependencies, and given --include=dev', t2 => {
    const testData = createDependencyTestConfig(testSpecs.version[1], versionData0, 'dev')
    let opts = makeOpts()
    opts.cmd.includeDev = true
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, name: versionData0.manifest.name },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its dependency'
      )
      let pkg = testData.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )

      pkg = versionData0.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for the devDependency are in the dlTracker data'
      )

      opts = makeOpts()
      // Bundled devDependency?! It's possible, isn't it?
      opts.cmd.includeDev = true
      testData.manifest.bundledDependencies = [ versionData0.manifest.name ]
      return itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    })
    .then(res => {
      let pkg = testData.manifest
      let depPkg = versionData0.manifest
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and not its bundled dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'bundled dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('package has a shrinkwrap and only regular dependencies', t2 => {
    const testData = createShrinkwrapTestConfig(testSpecs.version[1], versionData0)
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    let opts = makeOpts()
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, name: versionData0.manifest.name },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its dependency'
      )
      let pkg = testData.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )

      pkg = versionData0.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for the devDependency are in the dlTracker data'
      )

      opts = makeOpts()
      testData.manifest.bundledDependencies = [ versionData0.manifest.name ]
      return itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    })
    .then(res => {
      let pkg = testData.manifest
      let depPkg = versionData0.manifest
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and not its bundled dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'bundled dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('package has a shrinkwrap and only regular dependencies, but a dep fetch fails', t2 => {
    const testData = createShrinkwrapTestConfig(testSpecs.version[1], versionData0)
    mockPacote.setTestConfig({
      [testData.spec]: testData.manifest
    })
    t2.rejects(() => itemAgents.handleItem(testData.spec, makeOpts()))
    // For coverage. The error is a generic 'Unknown package' from our
    // mock pacote, but its nature doesn't really matter here.
    t2.end()
  })
  t1.test('package has devDependencies and a shrinkwrap, but no --include=dev', t2 => {
    const opts = makeOpts()
    const testData = createShrinkwrapTestConfig(testSpecs.version[1], versionData0, 'dev')
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      const pkg = testData.manifest
      const depPkg = versionData0.manifest
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and not its dev dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'dev dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('package has devDependencies, shrinkwrap, and is top-level, given --include=dev', t2 => {
    const opts = makeOpts()
    const testData = createShrinkwrapTestConfig(testSpecs.version[1], versionData0, 'dev')
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    opts.cmd.includeDev = true
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, name: versionData0.manifest.name },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its devDependency'
      )
      let pkg = testData.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )

      pkg = versionData0.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for the devDependency are in the dlTracker data'
      )
      t2.end()
    })
  })
  t1.test('package has devDependencies, shrinkwrap, and --include=dev, but not top-level', t2 => {
    const opts = makeOpts()
    const testData = createShrinkwrapTestConfig(testSpecs.version[1], versionData0, 'dev')
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    opts.cmd.includeDev = true
    itemAgents.handleItem(testData.spec, opts)
    .then(res => {
      const pkg = testData.manifest
      const depPkg = versionData0.manifest
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and not its dev dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'dev dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('package has optionalDependencies and shrinkwrap, given --omit=optional', t2 => {
    const opts = makeOpts()
    const testData = createShrinkwrapTestConfig(testSpecs.version[1], versionData0, 'optional')
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    opts.cmd.noOptional = true
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      const pkg = testData.manifest
      const depPkg = versionData0.manifest
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and not its optional dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'optional dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('package has optionalDependencies and shrinkwrap, but dependency fetch fails', t2 => {
    const opts = makeOpts()
    const testData = createShrinkwrapTestConfig(testSpecs.version[1], versionData0, 'optional')
    mockPacote.setTestConfig({
      [testData.spec]: testData.manifest
    })
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, failedOptional: true },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its failed optional Dependency'
      )
      const pkg = testData.manifest
      const depPkg = versionData0.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'optional dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('known registry package spec with peerDependencies, with --include=peer', t2 => {
    const testData = createDependencyTestConfig(testSpecs.version[1], versionData0, 'peer')
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    let opts = makeOpts()
    opts.cmd.includePeer = true
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, name: versionData0.manifest.name },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its peer dependency'
      )
      let pkg = testData.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      pkg = versionData0.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for the peer dependency are in the dlTracker data'
      )

      opts = makeOpts()
      opts.cmd.includePeer = true
      testData.manifest.bundledDependencies = [ versionData0.manifest.name ]
      return itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    })
    .then(res => {
      let pkg = testData.manifest
      let depPkg = versionData0.manifest
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and not its bundled dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'bundled peer dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('known registry package spec with optionalDependencies, without --omit=optional', t2 => {
    const testData = createDependencyTestConfig(testSpecs.version[1], versionData0, 'optional')
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [testData.spec]: testData.manifest
    })
    let opts = makeOpts()
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, name: versionData0.manifest.name },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its optional dependency'
      )
      let pkg = testData.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      pkg = versionData0.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for the optional dependency are in the dlTracker data'
      )

      opts = makeOpts()
      testData.manifest.bundledDependencies = [ versionData0.manifest.name ]
      return itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    })
    .then(res => {
      let pkg = testData.manifest
      let depPkg = versionData0.manifest
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and not its bundled optional dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'bundled optional dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })
  t1.test('known registry package spec with optionalDependencies, but dep fetch fails', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(testSpecs.version[1], versionData0, 'optional')
    mockPacote.setTestConfig({
      [testData.spec]: testData.manifest
    })
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, failedOptional: true },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its failed optional Dependency'
      )
      const pkg = testData.manifest
      const depPkg = versionData0.manifest
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'optional dependency data not added to the dlTracker'
      )
      t2.end()
    })
  })

  t1.test('given a known remote package spec', t2 => {
    const opts = makeOpts()
    const testData1 = testSpecs.remote[0]
    const testData2 = testSpecs.remote[1]
    mockPacote.setTestConfig({
      [testData1.spec]: testData1.manifest,
      [testData2.spec]: testData2.manifest
    })
    const p1 = itemAgents.handleItem(testData1.spec, { ...opts, topLevel: true })
    itemAgents.handleItem(testData2.spec, opts)
    .then(res2 => { // Expect this one to be reported as a duplicate request
      t2.strictSame(res2, [{ spec: testData2.spec, duplicate: true }])
      p1.then(res1 => {
        t2.strictSame(res1, [{ spec: testData1.spec }])
        expectDlTrackerData(
          t2, opts.dlTracker,
          'url', { spec: testData1.spec },
          'expected values for requested item are in the dlTracker data'
        )
        t2.end()
      })
    })
  })
  t1.test('given a known git repo package spec', t2 => {
    const opts = makeOpts()
    const testData = testSpecs.git[0]
    const testData2 = testSpecs.git[1]
    mockPacote.setTestConfig({
      [testData.spec]: testData.manifest,
      [testData2.spec]: testData2.manifest
    })
    mockPacote.setWait('tarball', testData.spec)
    const p1 = itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    itemAgents.handleItem(testData2.spec, { ...opts, topLevel: true })
    .then(res2 => {
      t2.strictSame(res2, [{ spec: testData2.spec, duplicate: true }])

      mockPacote.endWait('tarball', testData.spec)
      return p1.then(res1 => {
        t2.strictSame(res1, [{ spec: testData.spec }])
        const npaSpec = npa(testData.spec)
        const keys = gitTrackerKeys(npaSpec)
        expectDlTrackerData(
          t2, opts.dlTracker,
          'git', { name: keys.repo, spec: testData.manifest._sha },
          'expected values for item requested 1st are in the dlTracker data'
        )
      })
    })
    .then(() => {
      t2.test('package spec for a git repo that has already been downloaded', t3 => {
        const testData = testSpecs.git[2]
        mockPacote.setTestConfig({
          [testData.spec]: testData.manifest
        })
        itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
        .then(res => {
          t3.strictSame(res, [{ spec: testData.spec, duplicate: true }])
          t3.end()
        })
      })
      t2.end()
    })
  })
  t1.test('valid git repo package spec that cannot be parsed', t2 => {
    const opts = makeOpts()
    const testData = testSpecs.git[3]
    mockPacote.setTestConfig({
      [testData.spec]: testData.manifest
    })
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(res, [{ spec: testData.spec }])
      const pkg = testData.manifest
      const npaSpec = npa(testData.spec)
      const keys = gitTrackerKeys(npaSpec)
      expectDlTrackerData(
        t2, opts.dlTracker,
        'git', { name: keys.repo, spec: pkg._sha },
        'expected values for item requested 1st are in the dlTracker data'
      )
      t2.end()
    })
  })
  t1.test('git repo spec with commit hash, no associated tag', t2 => {
    const opts = makeOpts()
    const testData0 = testSpecs.git[0]
    const pkg = testData0.manifest
    const testData = {
      spec: `${testData0.spec}#${pkg._sha}`, manifest: { ...pkg }
    }
    // If the _allRefs value is an empty array (meaning: no tags found for
    // the item as specified), the dltracker omits the 'refs' property
    testData.manifest._allRefs = []
    mockPacote.setTestConfig({ [testData.spec]: testData.manifest })
    itemAgents.handleItem(testData.spec, { ...opts, topLevel: true })
    .then(res => {
      t2.strictSame(res, [{ spec: testData.spec }])
      const npaSpec = npa(testData.spec)
      const keys = gitTrackerKeys(npaSpec)
      const dlData = expectDlTrackerData(
        t2, opts.dlTracker,
        'git', { name: keys.repo, spec: pkg._sha },
        'dlTracker data contains the expected values'
      )
      t2.ok(!('refs' in dlData), 'dlTracker data contains no refs property')
      t2.end()
    })
  })
  t1.end()
})

