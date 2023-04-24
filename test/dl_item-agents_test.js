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

let mockDlt
let gitTrackerKeys
let itemAgents
let mockLockDeps
let mockLog
let mockPacote
let npf

tap.before(() =>
  makeAssets('tempAssets1', 'download/item-agents.js')
  .then(assets => {
    gitTrackerKeys = require(assets.libDownload + '/git-tracker-keys')
    itemAgents = require(assets.libDownload + '/item-agents')
    npf = require(assets.libDownload + '/npm-package-filename')
    mockDlt = require(assets.libDownload + '/dltracker')
    mockLockDeps = require(assets.libDownload + '/lock-deps')
    mockLog = require(assets.nodeModules + '/npmlog')
    mockPacote = require(assets.nodeModules + '/pacote')

    tap.teardown(() => rimrafAsync(assets.fs('rootName')))
  })
)

const makeOpts = (pkgDir) =>  ({
  dlTracker: mockDlt.createSync(pkgDir),
  flatOpts: { log: mockLog },
  cmd: {}
})
  /*
    DEV NOTES:
    * item-agents makes no mention of the cache, though it is passed in opts
      to other services (e.g., pacote)
    * it makes explicit mention of opts.flatOpts, but an empty object could suffice
    * it makes explicit mention of opts.dlTracker, *and* the ItemAgents use it!
      (contains(), add(), and path)
    * it uses opts.cmd fields: includeDev, noPeer, noOptional, noShrinkwrap
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

/*
  100% coverage is achieved mostly by a range of calls to getOperations,
  because that calls handleItem, which calls the other two exports
  (while processDependencies also calls handleItem); but explicit tests
  of xformResult allow us direct inspection.
*/

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

tap.test('getOperations', t1 => {
  const versionData0 = testSpecs.version[0]

  t1.test('bad arguments', t2 => {
    const nonArgs = [ undefined, null ]
    const nonObjects = [ true, 42, 'Bob', () => {} ]
    const opts = makeOpts()

    for (const arg of nonArgs)
      t2.throws(() => itemAgents.getOperations(arg, opts), SyntaxError)
    for (const arg of nonObjects.concat([ {} ]))
      t2.throws(() => itemAgents.getOperations(arg, opts), TypeError)

    for (const arg of nonArgs)
      t2.throws(() => itemAgents.getOperations([], arg), SyntaxError)
    for (const arg of nonObjects)
      t2.throws(() => itemAgents.getOperations([], arg), TypeError)

    t2.throws(() => itemAgents.getOperations([], {}), SyntaxError)

    const versionData1 = testSpecs.version[1]
    const lockfileDep = {
      name: versionData1.manifest.name,
      version: versionData1.manifest.version
    }
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest,
      [versionData1.spec]: versionData1.manifest
    })
    const opList = itemAgents.getOperations(
      [ versionData0.spec, lockfileDep ], makeOpts()
    )
    let count = 0
    return opList[0].then(res => {
      ++count
      t2.strictSame(
        res, [ { spec: versionData0.spec, name: versionData0.manifest.name } ]
      )
      return opList[1]
    })
    .then(() => {
      ++count
      throw new Error('rejection expected for 2nd item')
    })
    .catch(err => {
      t2.equal(count, 1)
      t2.match(err, TypeError)
    })
    .then(() => {
      const opList = itemAgents.getOperations(
        [ lockfileDep, versionData0.spec ], makeOpts()
      )
      count = 0
      return opList[0].then(res => {
        ++count
        t2.strictSame(res, [
          { spec: versionData1.spec, name: lockfileDep.name }
        ])
        return opList[1]
      })
      .then(() => {
        ++count
        throw new Error('rejection expected for 2nd item')
      })
      .catch(err => {
        t2.equal(count, 1)
        t2.match(err, TypeError)
      })
    })
    .finally(() => mockPacote.setTestConfig(null))
  })

  t1.test('empty list', t2 => {
    const opList = itemAgents.getOperations([], makeOpts())
    t2.same(opList, [])
    t2.end()
  })

  t1.test('given a semver package spec not known to the registry', t2 => {
    const opts = makeOpts()
    opts.topLevel = true
    mockPacote.setTestConfig(null)
    const opList = itemAgents.getOperations([ 'dummy0@99.99.99' ], opts)
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    t2.rejects(opList[0])
    t2.end()
  })

  t1.test('given a package spec of unhandled type', t2 => {
    const opts = makeOpts()
    opts.topLevel = true
    const opList = itemAgents.getOperations([ 'must/be/a/directory' ], opts)
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    t2.rejects(opList[0])
    t2.end()
  })

  t1.test('given an alias spec', t2 => {
    const aliasSpec = 'myalias@npm:' + versionData0.spec
    const opts = makeOpts()
    opts.topLevel = true
    mockLog.purge()
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest
    })
    const opList = itemAgents.getOperations([ aliasSpec ], opts)
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    return opList[0].then(result => {
      const pkg = versionData0.manifest
      t2.strictSame(result, [{ spec: versionData0.spec, name: pkg.name }])
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'Aliased package data should be stored as expected'
      )
    })
  })

  t1.test('known registry package spec', t2 => {
    const opts = makeOpts()
    mockPacote.setTestConfig({
      [versionData0.spec]: versionData0.manifest
    })
    // Simulate a delay in the response from pacote.manifest, so that we have
    // time to put in a duplicate request:
    mockPacote.setWait('manifest', versionData0.spec)
    const p1 = itemAgents.getOperations(
      [ versionData0.spec ], { ...opts, topLevel: true }
    )[0]
    // Make a 2nd request for same thing:
    itemAgents.getOperations([ versionData0.spec ], opts)[0]
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
      itemAgents.getOperations([ plainSpec ], opts)[0]
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
      itemAgents.getOperations([ anySpec ], opts)[0]
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
      itemAgents.getOperations([ versionData0.spec ], opts)[0]
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
    const opList = itemAgents.getOperations([ spec ], makeOpts())
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    t2.rejects(opList[0], /Invalid URL/)
    t2.end()
  })

  t1.test('an invalid manifest is fetched', t2 => {
    const badManifest = Object.assign({}, versionData0.manifest)
    const opts = makeOpts()
    badManifest._resolved = undefined
    mockPacote.setTestConfig({ [versionData0.spec]: badManifest })
    return t2.rejects(
      itemAgents.getOperations([ versionData0.spec ], opts)[0],
      /No _resolved value/
    )
    .then(() => {
      badManifest._resolved = true
      mockPacote.setTestConfig({ [versionData0.spec]: badManifest })
      return t2.rejects(
        itemAgents.getOperations([ versionData0.spec ], opts)[0],
        /Invalid _resolved value/
      )
      .then(() => {
        // Edge case - just about anything else sketchy gets interpreted
        // as something that looks meaningful, or throws a TypeError of
        // 'Invalid URL':
        badManifest._resolved = 'file:///'
        mockPacote.setTestConfig({ [versionData0.spec]: badManifest })
        return t2.rejects(
          itemAgents.getOperations([ versionData0.spec ], opts)[0],
          /Unable to parse meaningful data/
        )
      })
    })
  })

  t1.test('spec of a known registry package by tag', t2 => {
    const testData = testSpecs.tag[0]
    const opts = makeOpts()
    mockPacote.setTestConfig({ [testData.spec]: testData.manifest })
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true }
    )
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    return opList[0].then(res => {
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
    })
  })

  t1.test('spec of a known registry package by version range', t2 => {
    const testData = testSpecs.range[0]
    const pkg = testData.manifest
    const opts = makeOpts()
    mockPacote.setTestConfig({ [testData.spec]: pkg })
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true }
    )
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    return opList[0].then(res => {
      t2.strictSame(
        res,
        [{ spec: testData.spec, name: pkg.name }],
        'request gets corresponding non-duplicate result'
      )
      // Our mock dltracker does not have the ability to correctly answer a
      // query on a range spec; but we can fetch the data of the specific
      // version that we expect, and that will imply that handleItem had the
      // correct side effect.
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'Semver range spec package data should be stored as expected'
      )
    })
  })

  t1.test('package with only regular dependencies', t2 => {
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    let opts = makeOpts()
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true }
    )
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    return opList[0].then(res => {
      t2.strictSame(
        res, [
          { spec: versionData0.spec, name: depPkg.name },
          { spec: testData.spec, name: pkg.name }
        ],
        'request gets expected results for the item and its dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: depPkg.name, version: depPkg.version },
        'expected values for the dependency are in the dlTracker data'
      )

      opts = makeOpts()
      pkg.bundledDependencies = [ depPkg.name ]
      const opList = itemAgents.getOperations(
        [ testData.spec ], { ...opts, topLevel: true }
      )
      if (opList.length !== 1 || !(opList[0] instanceof Promise))
        t2.fail('Expected list containing a single element that is a Promise')
      return opList[0]
    })
    .then(res => {
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
    })
  })

  t1.test('package has only regular dependencies, dep fetch fails', t2 => {
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0
    )
    mockPacote.setTestConfig({
      [testData.spec]: testData.manifest
    })
    const opList = itemAgents.getOperations([ testData.spec ], makeOpts())
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    t2.rejects(opList[0])
    // For coverage. The error is a generic 'Unknown package' from our
    // mock pacote, but its nature doesn't really matter here.
    t2.end()
  })

  t1.test('top-level, devDependencies, include dev', t2 => {
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'dev'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    let opts = makeOpts()
    opts.cmd.includeDev = true
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true }
    )
    if (opList.length !== 1 || !(opList[0] instanceof Promise))
      t2.fail('Expected list containing a single element that is a Promise')
    return opList[0].then(res => {
      t2.strictSame(
        res, [
          { spec: versionData0.spec, name: depPkg.name },
          { spec: testData.spec, name: pkg.name }
        ],
        'request gets expected results for the item and its dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: depPkg.name, version: depPkg.version },
        'expected values for the devDependency are in the dlTracker data'
      )

      opts = makeOpts()
      // Bundled devDependency?! It's possible, isn't it?
      opts.cmd.includeDev = true
      pkg.bundledDependencies = [ depPkg.name ]
      const opList = itemAgents.getOperations(
        [ testData.spec ], { ...opts, topLevel: true }
      )
      if (opList.length !== 1 || !(opList[0] instanceof Promise))
        t2.fail('Expected list containing a single element that is a Promise')
      return opList[0]
    })
    .then(res => {
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
    })
  })

  t1.test('pkg has peerDeps, no flag for peer', t2 => {
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'peer'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    let opts = makeOpts()
    const opList = itemAgents.getOperations([ testData.spec ], opts)
    return opList[0].then(res => {
      // npm install brings in peer deps by default.
      // npm download follows that example.
      t2.strictSame(res, [
          { spec: versionData0.spec, name: depPkg.name },
          { spec: testData.spec, name: pkg.name }
        ],
        'request gets expected results for the item and its peer dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: depPkg.name, version: depPkg.version },
        'expected values for the peer dependency are in the dlTracker data'
      )

      pkg.bundledDependencies = [ depPkg.name ]
      // Don't need to call mockPacote.setTestConfig() again, because
      // mock pacote keeps the exact object from last time, so the above
      // changes what mockPacote has.
      opts = makeOpts()
      const opList = itemAgents.getOperations([ testData.spec ], opts)
      return opList[0]
    })
    .then(res => {
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
    })
  })

  t1.test('registry package with peerDeps, omit peer', t2 => {
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'peer'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    const opts = makeOpts()
    opts.cmd.noPeer = true
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true } // TODO: topLevel needed here?
    )
    return opList[0].then(res => {
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item and its peer dependency'
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
    })
  })

  t1.test('registry package with optionalDeps, no flag for optional', t2 => {
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'optional'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    let opts = makeOpts()
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true } // TODO: topLevel needed here?
    )
    return opList[0].then(res => {
      t2.strictSame(
        res, [
          { spec: versionData0.spec, name: versionData0.manifest.name },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its optional dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: depPkg.name, version: depPkg.version },
        'expected values for the optional dependency are in the dlTracker data'
      )

      opts = makeOpts()
      testData.manifest.bundledDependencies = [ depPkg.name ]
      const opList = itemAgents.getOperations(
        [ testData.spec ], { ...opts, topLevel: true } // TODO: topLevel needed here?
      )
      return opList[0]
    })
    .then(res => {
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
    })
  })

  t1.test('known registry package spec with optionalDeps, dep fetch fails', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'optional'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({ [testData.spec]: pkg })
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true } // TODO: topLevel needed here?
    )
    return opList[0].then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, failedOptional: true },
          { spec: testData.spec, name: testData.manifest.name }
        ],
        'request gets expected results for the item and its failed optional Dependency'
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
    })
  })

  t1.test('remote package specs', t2 => {
    const opts = makeOpts()
    const testData1 = testSpecs.remote[0]
    const testData2 = testSpecs.remote[1]
    mockPacote.setTestConfig({
      [testData1.spec]: testData1.manifest,
      [testData2.spec]: testData2.manifest
    })
    const p1 = itemAgents.getOperations(
      [ testData1.spec ], { ...opts, topLevel: true }
    )[0]
    const opList2 = itemAgents.getOperations([ testData2.spec ], opts)
    return opList2[0].then(res2 => {
      t2.strictSame(res2, [{ spec: testData2.spec, duplicate: true }])
      return p1.then(res1 => {
        t2.strictSame(res1, [{ spec: testData1.spec }])
        expectDlTrackerData(
          t2, opts.dlTracker,
          'url', { spec: testData1.spec },
          'expected values for requested item are in the dlTracker data'
        )
      })
    })
  })

  t1.test('git repo package spec', t2 => {
    const opts = makeOpts()
    const testData1 = testSpecs.git[0]
    const testData2 = testSpecs.git[1]
    mockPacote.setTestConfig({
      [testData1.spec]: testData1.manifest,
      [testData2.spec]: testData2.manifest
    })
    mockPacote.setWait('tarball', testData1.spec)
    const p1 = itemAgents.getOperations(
      [ testData1.spec ], { ...opts, topLevel: true }
    )[0]
    const opList2 = itemAgents.getOperations(
      [ testData2.spec ], { ...opts, topLevel: true }
    )
    return opList2[0].then(res2 => {
      t2.strictSame(res2, [{ spec: testData2.spec, duplicate: true }])

      mockPacote.endWait('tarball', testData1.spec)
      return p1.then(res1 => {
        t2.strictSame(res1, [{ spec: testData1.spec }])
        const npaSpec = npa(testData1.spec)
        const keys = gitTrackerKeys(npaSpec)
        expectDlTrackerData(
          t2, opts.dlTracker,
          'git', { name: keys.repo, spec: testData1.manifest._sha },
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
        const opList = itemAgents.getOperations(
          [ testData.spec ], { ...opts, topLevel: true }
        )
        return opList[0].then(res => {
          t3.strictSame(res, [{ spec: testData.spec, duplicate: true }])
        })
      })
      t2.end()
    })
  })

  t1.test('valid git repo package spec that cannot be parsed', t2 => {
    const opts = makeOpts()
    const testData = testSpecs.git[3]
    const pkg = testData.manifest
    mockPacote.setTestConfig({
      [testData.spec]: pkg
    })
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true }
    )
    return opList[0].then(res => {
      t2.strictSame(res, [{ spec: testData.spec }])
      const npaSpec = npa(testData.spec)
      const keys = gitTrackerKeys(npaSpec)
      expectDlTrackerData(
        t2, opts.dlTracker,
        'git', { name: keys.repo, spec: pkg._sha },
        'expected values for item requested 1st are in the dlTracker data'
      )
    })
  })

  t1.test('git repo spec with commit hash, no associated tag', t2 => {
    const opts = makeOpts()
    const testData0 = testSpecs.git[0]
    const pkg = testData0.manifest
    const altTestData = {
      spec: `${testData0.spec}#${pkg._sha}`, manifest: { ...pkg }
    }
    // If the _allRefs value is an empty array (meaning: no tags found for
    // the item as specified), the dltracker omits the 'refs' property
    altTestData.manifest._allRefs = []
    mockPacote.setTestConfig({ [altTestData.spec]: altTestData.manifest })
    const opList = itemAgents.getOperations(
      [ altTestData.spec ], { ...opts, topLevel: true }
    )
    return opList[0].then(res => {
      t2.strictSame(res, [{ spec: altTestData.spec }])
      const npaSpec = npa(altTestData.spec)
      const keys = gitTrackerKeys(npaSpec)
      const dlData = expectDlTrackerData(
        t2, opts.dlTracker,
        'git', { name: keys.repo, spec: pkg._sha },
        'dlTracker data contains the expected values'
      )
      t2.ok(!('refs' in dlData), 'dlTracker data contains no refs property')
    })
  })

  t1.end()
})

tap.test('getOperations shrinkwrap cases', t1 => {
  const versionData0 = testSpecs.version[0]

  t1.test('top-level pkg, only regular dependencies', t2 => {
    //
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    mockLockDeps.setTestConfig('extract', {
      data: [
        { name: depPkg.name, version: depPkg.version }
      ]
    })
    let opts = makeOpts()
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true }
    )
    return opList[0].then(res => {
      t2.strictSame(
        res, [
          { spec: versionData0.spec, name: depPkg.name },
          { spec: testData.spec, name: pkg.name }
        ],
        'request gets expected results for the item and its dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: depPkg.name, version: depPkg.version },
        'expected values for the dependency are in the dlTracker data'
      )

      // Keep in mind that makeOpts creates a new (mock) dltracker, so the
      // previous data is gone, and won't get mixed with what comes next
      opts = makeOpts()
      pkg.bundledDependencies = [ depPkg.name ] // this shouldn't matter
      mockLockDeps.setTestConfig('extract', {
        data: [ // THIS matters
          { name: depPkg.name, version: depPkg.version, inBundle: true }
        ]
      })
      const opList = itemAgents.getOperations(
        [ testData.spec ], { ...opts, topLevel: true }
      )
      return opList[0]
    })
    .then(res => {
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
    })
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  t1.test('only regular dependencies, dep fetch fails', t2 => {
    // For coverage. The error is a generic 'Unknown package' from our
    // mock pacote, but its nature doesn't really matter here.
    const depPkg = versionData0.manifest
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0
    )
    mockPacote.setTestConfig({ [testData.spec]: testData.manifest })
    mockLockDeps.setTestConfig('extract', {
      data: [ { name: depPkg.name, version: depPkg.version } ]
    })
    const opList = itemAgents.getOperations([ testData.spec ], makeOpts())
    return t2.rejects(opList[0])
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  t1.test('top-level pkg, devDependencies, no include', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'dev'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    mockLockDeps.setTestConfig('extract', {
      data: [ { name: depPkg.name, version: depPkg.version, dev: true } ]
    })
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true }
    )
    return opList[0].then(res => {
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
    })
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  t1.test('top-level pkg, devDependencies, include dev', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'dev'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    mockLockDeps.setTestConfig('extract', {
      data: [ { name: depPkg.name, version: depPkg.version, dev: true } ]
    })
    opts.cmd.includeDev = true
    const opList = itemAgents.getOperations(
      [ testData.spec ], { ...opts, topLevel: true }
    )
    return opList[0].then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, name: depPkg.name },
          { spec: testData.spec, name: pkg.name }
        ],
        'request gets expected results for the item and its devDependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: depPkg.name, version: depPkg.version },
        'expected values for the devDependency are in the dlTracker data'
      )
    })
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  t1.test('not top-level, devDependencies, include dev', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'dev'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    mockLockDeps.setTestConfig('extract', {
      data: [ { name: depPkg.name, version: depPkg.version, dev: true } ]
    })
    opts.cmd.includeDev = true
    const opList = itemAgents.getOperations([ testData.spec ], opts)
    return opList[0].then(res => {
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
    })
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  t1.test('peerDependencies, no omit option', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'peer'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    mockLockDeps.setTestConfig('extract', {
      data: [ { name: depPkg.name, version: depPkg.version, peer: true } ]
    })
    const opList = itemAgents.getOperations(
      [ testData.spec ], opts
    )
    return opList[0].then(res => {
      t2.strictSame(
        res, [
          { spec: versionData0.spec, name: depPkg.name },
          { spec: testData.spec, name: pkg.name }
        ],
        'request gets expected results for the item and its peer dependency'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: depPkg.name, version: depPkg.version },
        'expected values for peer dependency are in the dlTracker data'
      )
    })
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  t1.test('peerDependencies, omit peer', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'peer'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    mockLockDeps.setTestConfig('extract', {
      data: [ { name: depPkg.name, version: depPkg.version, peer: true } ]
    })
    opts.cmd.noPeer = true
    const opList = itemAgents.getOperations(
      [ testData.spec ], opts
    )
    return opList[0].then(res => {
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item, peer dep not included'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'expected values for requested item are in the dlTracker data'
      )
      t2.equal(
        opts.dlTracker.getData('semver', depPkg.name, depPkg.version),
        undefined,
        'peer dependency data not added to the dlTracker'
      )
    })
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  t1.test('optionalDependencies, omit optional', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'optional'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: depPkg,
      [testData.spec]: pkg
    })
    mockLockDeps.setTestConfig('extract', {
      data: [ { name: depPkg.name, version: depPkg.version, optional: true } ]
    })
    opts.cmd.noOptional = true
    const opList = itemAgents.getOperations(
      [ testData.spec ], opts
    )
    return opList[0].then(res => {
      t2.strictSame(
        res, [ { spec: testData.spec, name: pkg.name } ],
        'request gets expected results for the item, optional dep not included'
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
    })
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  t1.test('optionalDependencies, dependency fetch fails', t2 => {
    const opts = makeOpts()
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'optional'
    )
    const pkg = testData.manifest
    const depPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [testData.spec]: testData.manifest
    })
    mockLockDeps.setTestConfig('extract', {
      data: [ { name: depPkg.name, version: depPkg.version, optional: true } ]
    })
    const opList = itemAgents.getOperations(
      [ testData.spec ], opts
    )
    return opList[0].then(res => {
      t2.strictSame(
        res,
        [
          { spec: versionData0.spec, failedOptional: true },
          { spec: testData.spec, name: pkg.name }
        ],
        'request gets expected results for the item and its failed optional Dependency'
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
    })
    .finally(() => mockLockDeps.setTestConfig('extract', { data: [] }))
  })

  // The next two cases simulate a call from download() where the
  // deps are read from a user-provided lockfile, so that configuration
  // of mockLockDeps is unnecessary

  t1.test('devDependency with an optionalDep, include dev, omit optional', t2 => {
    const opts = makeOpts()
    opts.topLevel = true
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'optional'
    )
    const pkg = testData.manifest
    const devOptPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: devOptPkg,
      [testData.spec]: pkg
    })
    const depList = [
      { name: devOptPkg.name, version: devOptPkg.version, dev: true, optional: true },
      { name: pkg.name, version: pkg.version, dev: true }
    ]
    opts.cmd.includeDev = true
    opts.cmd.noOptional = true
    const opList = itemAgents.getOperations(depList, opts)
    return Promise.all(opList).then(res => {
      t2.strictSame(
        res, [ [ { spec: testData.spec, name: pkg.name } ] ],
        'devDependency expected in results, not its optional dep'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: pkg.name, version: pkg.version },
        'dlTracker data has expected values for devDependency'
      )
      t2.equal(
        opts.dlTracker.getData('semver', devOptPkg.name, devOptPkg.version),
        undefined,
        'optional dependency data not added to the dlTracker'
      )
    })
  })

  t1.test('devOptional, no include dev', t2 => {
    const opts = makeOpts()
    opts.topLevel = true
    const testData = createDependencyTestConfig(
      testSpecs.version[1], versionData0, 'optional'
    )
    const pkg = testData.manifest
    const devOptPkg = versionData0.manifest
    mockPacote.setTestConfig({
      [versionData0.spec]: devOptPkg,
      [testData.spec]: pkg
    })
    const depList = [
      { name: devOptPkg.name, version: devOptPkg.version, devOptional: true },
      { name: pkg.name, version: pkg.version, dev: true }
    ]
    const opList = itemAgents.getOperations(depList, opts)
    return Promise.all(opList).then(res => {
      t2.strictSame(
        res, [ [ { spec: versionData0.spec, name: devOptPkg.name } ] ],
        'only optional dep expected in results'
      )
      expectDlTrackerData(
        t2, opts.dlTracker,
        'semver', { name: devOptPkg.name, version: devOptPkg.version },
        'dlTracker data has expected values for optional dep'
      )
      t2.equal(
        opts.dlTracker.getData('semver', pkg.name, pkg.version),
        undefined,
        'dlTracker data does not have devDependency data'
      )
    })
  })

  t1.end()
})
