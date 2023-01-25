const path = require('path')
const { promisify } = require('util')

const rimrafAsync = promisify(require('rimraf'))
const tap = require('tap')

const makeAssets = require('./lib/make-assets')

let Download
let mockItemAgents
let mockLog
let mockNpmCfg
let mockPacote
let n2sAssets

// To mock npm.output for a given mock instance of npm
function makeOutputFn(list) {
  return (...msgs) => { list.push(msgs.join(' ')) }
}

//TODO: It may be important to save this as a guide for checking the opts that
//are passed to handleItem() and processDependencies()
// To validate the state that download exec() puts mock download/config into
function checkConfig(t, overrides = {}) {
/*
  t.equal(mockDlCfg.isFrozen(), true)
  const cmdOpts = mockDlCfg.get('opts')
  t.equal(cmdOpts.dlDir, mockNpmCfg.get('dl-dir'))
  t.equal(mockDlCfg.get('cache'), path.join(cmdOpts.dlDir || '.', 'dl-temp-cache'))
  t.equal(mockDlCfg.get('log'), mockLog)
  t.equal(!!cmdOpts.noShrinkwrap, !mockNpmCfg.get('package-lock'))
  t.equal(cmdOpts.packageJson, overrides.packageJson || null)
  // Any of these options not in overrides is expected to be undefined:
  t.equal(cmdOpts.noOptional, overrides.noOptional)
  t.equal(cmdOpts.includeDev, overrides.includeDev)
  t.equal(cmdOpts.includePeer, overrides.includePeer)
*/
}

tap.before(() =>
  makeAssets('tempAssets7', 'download.js')
  .then(assets => {
    n2sAssets = assets
    const MockNpmConfig = require(assets.nodeModules + '/@npmcli/config')
    mockLog = require(assets.nodeModules + '/npmlog')
    mockPacote = require(assets.nodeModules + '/pacote')

    Download = require(assets.npmLib + '/download')
    mockItemAgents = require(assets.libDownload + '/item-agents.js')

    mockNpmCfg = new MockNpmConfig({
      cmd: 'download', cwd: assets.fs('installPath'), log: mockLog
    })

    tap.teardown(() => rimrafAsync(assets.fs('rootName')))
  })
)

tap.test('No arguments, no package-json option', t1 => {
  const npmMsgs = []
  const dl = new Download({
    config: mockNpmCfg, output: makeOutputFn(npmMsgs)
  })
  dl.exec([], function(err) {
    t1.type(err, SyntaxError)
    t1.match(err, /No packages named for download/)
    t1.same(npmMsgs, []) // because it aborts before npm.output is used
    t1.end()
  })
})

tap.test('package-json options', t1 => {
  t1.before(() => {
    mockPacote.setTestConfig({
      './': {
        name: 'dummy1', version: '1.0.0',
      },
      [n2sAssets.fs('installPath')]: {
        name: 'dummy2', version: '2.0.0',
      }
    })
    mockItemAgents.setTestConfig('processDependencies', {
      'dummy1@1.0.0': [],
      'dummy2@2.0.0': []
    })
  })

  function checkLogNoArgsNoPjPath(t) {
    const msgs = mockLog.getList()
    t.equal(msgs.length, 3)
    t.match(msgs[0], {
      level: 'silly', prefix: 'download', message: 'args: '
    })
    t.match(msgs[1], {
      level: 'warn', prefix: 'download', message: /^No path configured/
    })
    t.match(msgs[2], {
      level: 'info', prefix: 'download',
      message: /^established download path:/
    })
  }

  function pjImplicitCwdTest(t, option) {
    mockNpmCfg.set(option, true)
    mockLog.purge()
    const npmMsgs = []
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn(npmMsgs)
    })
    dl.exec([], function(err, results) {
      t.equal(!!err, false)
      //const cmdOpts = mockDlCfg.get('opts')
      //t.equal(cmdOpts.packageJson, './')
      // Here, the log has nothing beyond 'established download path'
      checkLogNoArgsNoPjPath(t)
      t.equal(npmMsgs.length, 1)
      t.equal(
        npmMsgs[0],
        '\nNothing new to download for package.json\n\ndownload finished.'
      )
      mockNpmCfg.set(option, undefined)
      t.end()
    })
  }
  // Covers line 216 (the catch()), but from specific source: pacote.manifest
  t1.test('--package-json, no explicit path, no package.json in cwd', t2 => {
    mockLog.purge()
    mockPacote.setErrorState('manifest', true, 'ENOENT')
    mockNpmCfg.set('package-json', true)
    const npmMsgs = []
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn(npmMsgs)
    })
    dl.exec([], function(err) {
      t2.type(err, Error, 'pacote.manifest error is passed along')
      checkLogNoArgsNoPjPath(t2)
      t2.same(npmMsgs, [])
      mockPacote.setErrorState('manifest', false)
      mockNpmCfg.set('package-json', undefined)
      t2.end()
    })
  })

  t1.test('--package-json, no explicit path, package.json in cwd, but has no deps', t2 => {
    pjImplicitCwdTest(t2, 'package-json')
  })

  t1.test('--pj, no explicit path, package.json in cwd, but has no deps', t2 => {
    pjImplicitCwdTest(t2, 'pj')
  })

  t1.test('-J, package.json in cwd, but has no deps', t2 => {
    pjImplicitCwdTest(t2, 'J')
  })

  function pjExplicitDirTest(t, option) {
    const pjWhere = n2sAssets.fs('installPath')
    mockNpmCfg.set(option, pjWhere)
    mockLog.purge()
    const npmMsgs = []
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn(npmMsgs)
    })
    dl.exec([], function(err, results) {
      t.equal(!!err, false)
      //const cmdOpts = mockDlCfg.get('opts')
      //t.equal(cmdOpts.packageJson, pjWhere)
      // Here, the log has nothing beyond 'established download path'
      checkLogNoArgsNoPjPath(t)
      t.equal(npmMsgs.length, 1)
      t.equal(
        npmMsgs[0],
        '\nNothing new to download for package.json\n\ndownload finished.'
      )
      mockNpmCfg.set(option, undefined)
      t.end()
    })
  }

  t1.test('--package-json with explicit path that has package.json, but no deps', t2 => {
    pjExplicitDirTest(t2, 'package-json')
  })

  t1.test('--pj with explicit path that has package.json, but no deps', t2 => {
    pjExplicitDirTest(t2, 'pj')
  })

  t1.test('--package-json, no explicit path, package.json in cwd, has deps', t2 => {
    mockPacote.setTestConfig({
      './': {
        name: 'dummy1', version: '1.0.0',
        dependencies: { 'reg-dep-1': '1.2.3' }
      }
    })
    mockItemAgents.setTestConfig('processDependencies', {
      'dummy1@1.0.0': [
        { spec: 'reg-dep-1@1.2.3', name: 'reg-dep-1' }
      ]
    })
    mockNpmCfg.set('package-json', true)
    mockLog.purge()
    const npmMsgs = []
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn(npmMsgs)
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkLogNoArgsNoPjPath(t2)
      t2.match(
        npmMsgs[0],
        /Downloaded tarballs to satisfy 1 dependency derived from package.json/
      )
      mockNpmCfg.set('package-json', undefined)
      t2.end()
    })
  })

  // to hit line 134
  t1.test('--package-json=package.json', t2 => {
    // Here we can re-use the mockPacote and mockItemAgents data set by the
    // previous test
    mockNpmCfg.set('package-json', 'package.json')
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      //t2.equal(mockDlCfg.get('opts').packageJson, './')
      mockNpmCfg.set('package-json', undefined)
      t2.end()
    })
  })
  // to hit line 194
  tap.test('--package-json and package spec argument', t1 => {
    const pjDepName = 'reg-dep-2'
    const pjDepVSpec = '^2'
    const argPkgName = 'dummy1'
    const argSpec = argPkgName
    const argDepName = 'reg-dep-1'
    const argDepVSpec = '^1'
    const injectedPJDepResults = {
      spec: `${pjDepName}@${pjDepVSpec}`, name: pjDepName
    }
    const injectedPkgArgResults = [
      { spec: argSpec, name: argPkgName },
      { spec: `${argDepName}@${argDepVSpec}`, name: argDepName }
    ]

    mockPacote.setTestConfig({
      [n2sAssets.fs('installPath')]: { // the package.json
        name: 'dummy2', version: '2.0.0',
        dependencies: { [pjDepName]: pjDepVSpec }
      },
      [argSpec]: { // the package spec given on the command line
        name: argPkgName, version: '1.0.0',
        dependencies: { [argDepName]: argDepVSpec }
      }
    })
    mockItemAgents.setTestConfig('processDependencies', {
      'dummy2@2.0.0': [ injectedPJDepResults ] // for the package.json
    })
    mockItemAgents.setTestConfig('handleItem', {
      [argSpec]: injectedPkgArgResults // for the spec from the command line
    })
    mockNpmCfg.set('pj', n2sAssets.fs('installPath'))
    mockLog.purge()
    const npmMsgs = []
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn(npmMsgs)
    })
    dl.exec(['dummy1'], function(err, results) {
      t1.equal(!!err, false)
      t1.same(results, [
        injectedPJDepResults,
        injectedPkgArgResults
      ])
      const msgs = mockLog.getList()
      t1.equal(msgs.length > 0, true)
      t1.match(msgs[0], {
        level: 'silly', prefix: 'download', message: 'args: ' + argSpec
      })
      const p1 = /Downloaded tarballs to satisfy 1 dependency derived from package\.json/
      const p2 = new RegExp(`Downloaded tarballs to satisfy ${argSpec} and 1 dependency`)
      t1.match(npmMsgs[0], p1)
      t1.match(npmMsgs[0], p2)
      t1.end()
    })
  })

  t1.end()
})

tap.test('Options for dependencies', t1 => {
  t1.before(() => {
    /*
      For this set of tests, we don't need to set up a package with each of
      the kinds of dependencies, because the handling of those does not happen
      in download.js, but in item-agents.js. All we need to do is check that
      the config object (download/config.js) has received the correct settings.

      Because it presents too much of a distraction to set up a mock package
      to represent a command line argument for this set of tests, we'll simply
      go with an implied package.json in the current directory:
    */
    mockNpmCfg.set('package-json', true)
  })
  t1.teardown(() => {
    mockNpmCfg.set('package-json', undefined)
  })

  t1.test('--omit=optional', t2 => {
    mockNpmCfg.set('omit', ['optional'])
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './',
        noOptional: true
      })
      mockNpmCfg.set('omit', [])
      t2.end()
    })
  })
  t1.test('--include=dev', t2 => {
    mockNpmCfg.set('include', ['dev'])
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './',
        includeDev: true
      })
      mockNpmCfg.set('include', [])
      t2.end()
    })
  })
  t1.test('--include=dev --include=peer', t2 => {
    mockNpmCfg.set('include', ['dev', 'peer'])
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './',
        includeDev: true,
        includePeer: true
      })
      mockNpmCfg.set('include', [])
      t2.end()
    })
  })
  t1.test('--include=dev --include=peer --omit=optional', t2 => {
    mockNpmCfg.set('include', ['dev', 'peer'])
    mockNpmCfg.set('omit', ['optional'])
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './',
        includeDev: true,
        includePeer: true,
        noOptional: true
      })
      mockNpmCfg.set('include', [])
      t2.end()
    })
  })
  t1.test('--include=dev --include=peer --include=optional', t2 => {
    mockNpmCfg.set('include', ['dev', 'peer', 'optional'])
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './',
        includeDev: true,
        includePeer: true
      })
      mockNpmCfg.set('include', [])
      t2.end()
    })
  })
  t1.test('--include=peer --include=optional', t2 => {
    mockNpmCfg.set('include', ['peer', 'optional'])
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './',
        includePeer: true
      })
      mockNpmCfg.set('include', [])
      t2.end()
    })
  })
  t1.test('--include=optional --omit=optional', t2 => {
    mockNpmCfg.set('include', ['optional'])
    // 'include' overrides 'omit':
    mockNpmCfg.set('omit', ['optional'])
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './'
      })
      mockNpmCfg.set('include', [])
      mockNpmCfg.set('omit', [])
      t2.end()
    })
  })
  t1.test('--include=dev --omit=dev --include=peer --omit=peer', t2 => {
    mockNpmCfg.set('include', ['dev', 'peer'])
    mockNpmCfg.set('omit', ['dev', 'peer'])
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './',
        includeDev: true,
        includePeer: true
      })
      mockNpmCfg.set('include', [])
      mockNpmCfg.set('omit', [])
      t2.end()
    })
  })

  // checkConfig() always verifies that
  //   !!cmdOpts.noShrinkwrap === !mockNpmCfg.get('package-lock')
  t1.test('--package-lock(=true)', t2 => {
    mockNpmCfg.set('package-lock', true)
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './'
      })
      t2.end()
    })
  })
  t1.test('--package-lock=false', t2 => {
    mockNpmCfg.set('package-lock', false)
    const dl = new Download({
      config: mockNpmCfg, output: makeOutputFn([])
    })
    dl.exec([], function(err, results) {
      t2.equal(!!err, false)
      checkConfig(t2, {
        packageJson: './'
        // checkConfig always verifies that
        //   !!cmdOpts.noShrinkwrap === !mockNpmCfg.get('package-lock')
      })
      mockNpmCfg.set('package-lock', undefined)
      t2.end()
    })
  })
  t1.end()
})

tap.test('--dl-dir given with a package spec argument', t1 => {
  const pkgName = 'dummy1'
  const injectedData = [ { spec: pkgName, name: pkgName } ]
  mockItemAgents.setTestConfig('handleItem', {
    [pkgName]: injectedData
  })
  mockNpmCfg.set('dl-dir', n2sAssets.fs('pkgPath'))
  const npmMsgs = []
  const dl = new Download({
    config: mockNpmCfg, output: makeOutputFn(npmMsgs)
  })
  dl.exec([pkgName], function(err, results) {
    t1.equal(!!err, false)
    t1.same(results, [ injectedData ])
    t1.match(
      npmMsgs[0],
      new RegExp(`Downloaded tarballs to satisfy ${pkgName} and 0 dependencies`)
    )
    mockNpmCfg.set('dl-dir', undefined)
    t1.end()
  })
})

tap.test('An optional dependency fetch fails', t1 => {
  mockPacote.setTestConfig({
    'dummy1': {
      name: 'dummy1', version: '1.0.0',
      optionalDependencies: {
        'reg-dep-1': '1.2.3'
      }
    }
  })
  const injectedResults = [
    { spec: 'dummy1', name: 'dummy1' },
    { spec: 'reg-dep-1@1.2.3', name: 'reg-dep-1', failedOptional: true }
  ]
  mockItemAgents.setTestConfig('handleItem', {
    'dummy1': injectedResults
  })
  const npmMsgs = []
  const dl = new Download({
    config: mockNpmCfg, output: makeOutputFn(npmMsgs)
  })
  dl.exec(['dummy1'], function(err, results) {
    t1.equal(!!err, false)
    t1.same(results, [ injectedResults ])
    t1.match(npmMsgs[0], /\(failed to fetch 1 optional packages\)/)
    t1.end()
  })
})

tap.test('A duplicate spec occurs', t1 => {
  const pkgName = 'dummy1'
  const dupSpec = pkgName + '@^1'
  const version = '1.0.0'
  const injectedResults = [
    [{ spec: pkgName, name: pkgName }],
    [{ spec: [dupSpec], name: pkgName, duplicate: true }]
  ]
  mockPacote.setTestConfig({
    [pkgName]: { name: pkgName, version },
    [dupSpec]: { name: pkgName, version }
  })
  mockItemAgents.setTestConfig('handleItem', {
    [pkgName]: injectedResults[0],
    [dupSpec]: injectedResults[1]
  })
  const npmMsgs = []
  const dl = new Download({
    config: mockNpmCfg, output: makeOutputFn(npmMsgs)
  })
  dl.exec([pkgName, dupSpec], function(err, results) {
    t1.equal(!!err, false)
    t1.same(results, injectedResults)
    t1.match(
      npmMsgs[0],
      new RegExp(`Downloaded tarballs to satisfy ${pkgName} and 0 dependencies`)
    )
    t1.match(
      npmMsgs[0],
      new RegExp(`Nothing new to download for ${pkgName}@[^]1`)
    )
    t1.match(npmMsgs[0], /\(1 duplicate spec skipped\)/)
    t1.end()
  })
})

