const fs = require('fs')
const path = require('path')
const { promisify } = require('util')

const rimrafAsync = promisify(require('rimraf'))
const tap = require('tap')

const makeAssets = require('./lib/make-assets')

const testRootName = 'tempAssets7'
let Download
let mockItemAgents
let mockLockDeps
let mockLog
let mockNpmClass
let mockPacote
let n2sAssets

const makeMockNpm = (args = {}) => {
  const opts = {
    cmd: 'download', cwd: n2sAssets.fs('installPath'),
    log: mockLog,
    args
  }
  return new mockNpmClass(opts)
}

// To help check the cmd opts passed to handleItem/processDependencies
const expectPropsAbsent = (t, obj, props) => {
  const badOpts = []
  for (const name in props)
    if (name in obj) badOpts.push(name)
  if (badOpts.length)
    t.fail('Unexpected option(s) present: ' + badOpts.join(', '))
}

tap.before(() =>
  makeAssets(testRootName, 'download.js')
  .then(assets => {
    n2sAssets = assets
    mockNpmClass = require(assets.npmLib + '/npm')
    mockLog = require(assets.nodeModules + '/npmlog')
    mockPacote = require(assets.nodeModules + '/pacote')
    Download = require(assets.npmLib + '/download')
    mockItemAgents = require(assets.libDownload + '/item-agents.js')
    mockLockDeps = require(assets.libDownload + '/lock-deps.js')
  })
)
tap.teardown(() => rimrafAsync(path.join(__dirname, testRootName)))

tap.test('No arguments, no package-json or lockfile-dir options', t1 => {
  const mockNpm = makeMockNpm()
  const dl = new Download(mockNpm)
  dl.exec([], function(err) {
    t1.match(err, /No packages named for download/)
    t1.same(mockNpm.outputMsgs, []) // because it aborts before npm.output is used
    t1.end()
  })
})

tap.test('package-json options', t1 => {
  // Most of the tests below use these defaults, but some override them.
  // This is for the overriders to restore the defaults.
  const setProviderDefaults = () => {
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
  }

  t1.before(() => setProviderDefaults())

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

  t1.test('--package-json, no path given', t2 => {
    const mockNpm = makeMockNpm({ 'package-json': true })
    const dl = new Download(mockNpm)
    mockLog.purge()
    dl.exec([], function(err) {
      t2.equal(err.message, 'package-json option must be given a path')
      t2.same(mockNpm.outputMsgs, [])
      t2.end()
    })
  })

  t1.test('-J, package.json in cwd, but has no deps', t2 => {
    const mockNpm = makeMockNpm({ 'J': true })
    const dl = new Download(mockNpm)
    mockLog.purge()
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      // Here, the log has nothing beyond 'established download path'
      checkLogNoArgsNoPjPath(t2)
      t2.same(
        mockNpm.outputMsgs, [
          '\nNothing new to download for package.json\n\ndownload finished.'
        ]
      )
      t2.end()
    })
  })

  t1.test('--package-json with explicit path that has package.json, but no deps', t2 => {
    const pjWhere = n2sAssets.fs('installPath')
    const mockNpm = makeMockNpm({ 'package-json': pjWhere })
    const dl = new Download(mockNpm)
    mockLog.purge()
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      // Here, the log has nothing beyond 'established download path'
      checkLogNoArgsNoPjPath(t2)
      t2.same(
        mockNpm.outputMsgs, [
          '\nNothing new to download for package.json\n\ndownload finished.'
        ]
      )
      t2.end()
    })
  })

  t1.test('--package-json=.', t2 => {
    const mockNpm = makeMockNpm({ 'package-json': '.' })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.end()
    })
  })

  t1.test('--package-json=package.json', t2 => {
    const mockNpm = makeMockNpm({ 'package-json': 'package.json' })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      // TODO: see if we can't follow the intent of this somehow:
      //t2.equal(mockDlCfg.get('opts').packageJson, './')
      t2.end()
    })
  })

  t1.test('-J, package.json in cwd, has deps', t2 => {
    const mockNpm = makeMockNpm({ 'J': true })
    const dl = new Download(mockNpm)
    mockLog.purge()
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
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      checkLogNoArgsNoPjPath(t2)
      t2.match(
        mockNpm.outputMsgs[0],
        /Downloaded tarballs to satisfy 1 dependency derived from package.json/
      )
      setProviderDefaults()
      t2.end()
    })
  })

  t1.test('--package-json and package spec argument', t2 => {
    const mockNpm = makeMockNpm({
      'package-json': n2sAssets.fs('installPath')
    })
    const dl = new Download(mockNpm)
    const pjDepName = 'reg-dep-2'
    const pjDepVSpec = '^2'
    const argPkgName = 'dummy1'
    const argSpec = argPkgName
    const argDepName = 'reg-dep-1'
    const argDepVSpec = '^1'
    const injectedPJDepResults = [
      { spec: `${pjDepName}@${pjDepVSpec}`, name: pjDepName }
    ]
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
      'dummy2@2.0.0': injectedPJDepResults // for the package.json
    })
    mockItemAgents.setTestConfig('getOperations', {
      [argSpec]: injectedPkgArgResults // for the spec from the command line
    })
    mockLog.purge()

    dl.exec([argPkgName], function(err, results) {
      t2.same(results, [
        injectedPJDepResults,
        injectedPkgArgResults
      ])
      const msgs = mockLog.getList()
      t2.equal(msgs.length > 0, true)
      t2.match(msgs[0], {
        level: 'silly', prefix: 'download', message: 'args: ' + argSpec
      })
      t2.match(
        mockNpm.outputMsgs[0],
        /Downloaded tarballs to satisfy 1 dependency derived from package\.json/
      )
      t2.match(
        mockNpm.outputMsgs[0],
        new RegExp(`Downloaded tarballs to satisfy ${argSpec} and 1 dependency`)
      )
      setProviderDefaults()
      t2.end()
    })
  })

  t1.end()
})

tap.test('lockfile-dir option', t1 => {
  // Most of the tests below use these defaults, but some override them.
  // This is for the overriders to restore the defaults.
  const setProviderDefaults = () => {
    mockItemAgents.setTestConfig('getOperations', {
      'dummy1@1.0.0': [{ name: 'dummy1', spec: '1.0.0' }],
      'dummy2@2.0.0': [{ name: 'dummy2', spec: '2.0.0' }]
    })
  }

  t1.before(() => setProviderDefaults())

  t1.test('No path given, no following option', t2 => {
    const mockNpm = makeMockNpm({ 'lockfile-dir': true })
    const dl = new Download(mockNpm)
    mockLog.purge()
    dl.exec([], function(err) {
      t2.equal(err.message, 'lockfile-dir option must be given a path')
      t2.same(mockNpm.outputMsgs, [])
      t2.end()
    })
  })

  t1.test('No path given, with following option', t2 => {
    const mockNpm = makeMockNpm({ 'lockfile-dir': '--registry' })
    const dl = new Download(mockNpm)
    mockLog.purge()
    dl.exec([], function(err) {
      t2.equal(err.message, 'lockfile-dir option must be given a path')
      t2.same(mockNpm.outputMsgs, [])
      t2.end()
    })
  })

  t1.test('--lockfile-dir=.', t2 => {
    const mockNpm = makeMockNpm({ 'lockfile-dir': '.' })
    const dl = new Download(mockNpm)
    const name = 'dummy1'
    const version = '1.0.0'
    mockLockDeps.setTestConfig('readFromDir', { data: [{ name, version }] })
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.same(results, [[ { name, spec: version } ]])
      t2.equal(mockItemAgents.getLastOpts().cmd.lockfileDir, './')
      t2.end()
    })
  })

  t1.test('--lockfile-dir=npm-shrinkwrap.json', t2 => {
    const mockNpm = makeMockNpm({ 'lockfile-dir': 'npm-shrinkwrap.json' })
    const dl = new Download(mockNpm)
    const name = 'dummy2'
    const version = '2.0.0'
    mockLockDeps.setTestConfig('readFromDir', { data: [{ name, version }] })
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.same(results, [[ { name, spec: version } ]])
      t2.equal(mockItemAgents.getLastOpts().cmd.lockfileDir, './')
      t2.end()
    })
  })

  t1.test('--lockfile-dir=a/package-lock.json', t2 => {
    const mockNpm = makeMockNpm({ 'lockfile-dir': 'a/package-lock.json' })
    const dl = new Download(mockNpm)
    const name = 'dummy1'
    const version = '1.0.0'
    mockLockDeps.setTestConfig('readFromDir', { data: [{ name, version }] })
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.same(results, [[ { name, spec: version } ]])
      t2.equal(mockItemAgents.getLastOpts().cmd.lockfileDir, 'a')
      t2.end()
    })
  })

  t1.test('--lockfile-dir=a\\b\\yarn.lock', t2 => {
    const mockNpm = makeMockNpm({ 'lockfile-dir': 'a\\b\\yarn.lock' })
    const dl = new Download(mockNpm)
    const name = 'dummy2'
    const version = '2.0.0'
    mockLockDeps.setTestConfig('readFromDir', { data: [{ name, version }] })
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.same(results, [[ { name, spec: version } ]])
      t2.equal(mockItemAgents.getLastOpts().cmd.lockfileDir, 'a\\b')
      t2.end()
    })
  })

  t1.test('No lockfile at given location, or no deps', t2 => {
    const mockNpm = makeMockNpm({ 'lockfile-dir': 'a/b/c' })
    const dl = new Download(mockNpm)
    mockLockDeps.setTestConfig('readFromDir', { data: [] })
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.same(results, [])
      // handleItem does not get called, because there are no deps
      t2.end()
    })
  })

  // For coverage of the line with call to checkLockfileDep()
  t1.test('lockfile contains a devDependency', t2 => {
    const mockNpm = makeMockNpm({ 'lockfile-dir': 'a/b/c' })
    const dl = new Download(mockNpm)
    const name = 'dummy2'
    const version = '2.0.0'
    mockLockDeps.setTestConfig('readFromDir', {
      data: [
        { name: 'dummy1', version: '1.0.0', dev: true },
        { name, version }
      ]
    })
    mockItemAgents.setTestConfig('getOperations', {
      'dummy1@1.0.0': null,
      [name + '@' + version]: [{ name, spec: version }]
    })
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.same(results, [[ { name, spec: version } ]])
      setProviderDefaults()
      t2.end()
    })
  })

  t1.test('After getting deps from package.json', t2 => {
    const mockNpm = makeMockNpm({ 'J': true, 'lockfile-dir': 'a/b/c' })
    const dl = new Download(mockNpm)
    const pjDepName = 'reg-dep-1'
    const pjData = { [pjDepName]: '1.2.3' }
    const lockfileData = { name: 'dummy2', version: '2.0.0' }
    const expectedResults = [
      { name: pjDepName, spec: pjDepName + '@' + pjData[pjDepName] },
      { name: lockfileData.name, spec: lockfileData.version }
    ]
    mockLockDeps.setTestConfig('readFromDir', { data: [ lockfileData ] })
    mockPacote.setTestConfig({
      './': {
        name: 'dummy1', version: '1.0.0',
        dependencies: pjData
      }
    })
    mockItemAgents.setTestConfig('processDependencies', {
      'dummy1@1.0.0': [ expectedResults[0] ]
    })
    mockLog.purge()
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.same(results, [ [ expectedResults[0] ], [ expectedResults[1] ] ])
      const prefix = 'Downloaded tarballs to satisfy 1 dependency derived from '
      if (!mockNpm.outputMsgs[0].includes(prefix + 'package.json\n'))
        t2.fail('Failed to find expected package.json deps results')
      if (!mockNpm.outputMsgs[0].includes(prefix + 'lockfile\n'))
        t2.fail('Failed to find expected lockfile deps results')
      t2.end()
    })
  })

  t1.end()
})

tap.test('Options for dependencies', t1 => {
  /*
    For this set of tests, we don't need to set up a package with each of
    the kinds of dependencies, because the handling of those does not happen
    in download.js, but in item-agents.js. All we need to do is check that
    the config object (download/config.js) has received the correct settings.

    Because it presents too much of a distraction to set up a mock package
    to represent a command line argument for this set of tests, we'll simply
    go with an implied package.json in the current directory.
  */

  t1.test('--omit=optional', t2 => {
    const mockNpm = makeMockNpm({ 'J': true, 'omit': ['optional'] })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(cmdOpts, { noOptional: true, packageJson: './' })
      expectPropsAbsent(t2, cmdOpts, [ 'includeDev', 'noPeer' ])
      t2.end()
    })
  })
  t1.test('--omit=peer', t2 => {
    const mockNpm = makeMockNpm({ 'J': true, 'omit': ['peer'] })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(cmdOpts, { noPeer: true, packageJson: './' })
      expectPropsAbsent(t2, cmdOpts, [ 'includeDev', 'noOptional' ])
      t2.end()
    })
  })
  t1.test('--include=dev', t2 => {
    const mockNpm = makeMockNpm({ 'J': true, 'include': ['dev'] })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(cmdOpts, { includeDev: true, packageJson: './' })
      expectPropsAbsent(t2, cmdOpts, [ 'noOptional', 'noPeer' ])
      t2.end()
    })
  })
  t1.test('--include=dev --include=peer', t2 => {
    const mockNpm = makeMockNpm({ 'J': true, 'include': ['dev', 'peer'] })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(
        cmdOpts, { includeDev: true, packageJson: './' }
      )
      expectPropsAbsent(t2, cmdOpts, [ 'noOptional', 'noPeer' ])
      t2.end()
    })
  })
  t1.test('--include=dev --include=peer --omit=optional', t2 => {
    const mockNpm = makeMockNpm({
      'J': true, 'include': ['dev', 'peer'], 'omit': ['optional']
    })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      t2.match(
        mockItemAgents.getLastOpts().cmd,
        { includeDev: true, noOptional: true, packageJson: './' }
      )
      t2.end()
    })
  })
  t1.test('--include=dev --include=peer --include=optional', t2 => {
    const mockNpm = makeMockNpm({
      'J': true, 'include': ['dev', 'peer', 'optional']
    })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(
        cmdOpts, { includeDev: true, packageJson: './' }
      )
      expectPropsAbsent(t2, cmdOpts, [ 'noOptional', 'noPeer' ])
      t2.end()
    })
  })
  t1.test('--include=peer --include=optional', t2 => {
    const mockNpm = makeMockNpm({
      'J': true, 'include': ['peer', 'optional']
    })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(cmdOpts, { packageJson: './' })
      expectPropsAbsent(t2, cmdOpts, [ 'includeDev', 'noOptional', 'noPeer' ])
      t2.end()
    })
  })
  t1.test('--include=optional --omit=optional', t2 => {
    const mockNpm = makeMockNpm({
      'J': true, 'include': ['optional'], 'omit': ['optional']
    })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(cmdOpts, { packageJson: './' })
      expectPropsAbsent(
        t2, cmdOpts, [ 'includeDev', 'noPeer', 'noOptional' ]
      )
      t2.end()
    })
  })
  t1.test('--include=dev --omit=dev --include=peer --omit=peer', t2 => {
    const mockNpm = makeMockNpm({
      'J': true, 'include': ['dev', 'peer'], 'omit': ['dev', 'peer']
    })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(
        cmdOpts, { includeDev: true, packageJson: './' }
      )
      expectPropsAbsent(t2, cmdOpts, [ 'noOptional', 'noPeer' ])
      t2.end()
    })
  })

  t1.test('--package-lock(=true)', t2 => {
    const mockNpm = makeMockNpm({ 'J': true, 'package-lock': true })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(cmdOpts, { packageJson: './' })
      expectPropsAbsent(t2, cmdOpts, [ 'noShrinkwrap' ])
      t2.end()
    })
  })
  t1.test('--package-lock=false', t2 => {
    const mockNpm = makeMockNpm({ 'J': true, 'package-lock': false })
    const dl = new Download(mockNpm)
    dl.exec([], function(err, results) {
      t2.error(err, 'expect no error')
      const cmdOpts = mockItemAgents.getLastOpts().cmd
      t2.match(cmdOpts, { noShrinkwrap: true, packageJson: './' })
      t2.end()
    })
  })

  t1.end()
})

tap.test('--dl-dir given with a package spec argument', t1 => {
  const mockNpm = makeMockNpm({ 'dl-dir': n2sAssets.fs('pkgPath') })
  const dl = new Download(mockNpm)
  const pkgName = 'dummy1'
  const injectedData = [ { spec: pkgName, name: pkgName } ]
  mockItemAgents.setTestConfig('getOperations', {
    [pkgName]: injectedData
  })
  dl.exec([pkgName], function(err, results) {
    t1.error(err, 'expect no error')
    t1.same(results, [ injectedData ])
    t1.match(
      mockNpm.outputMsgs[0],
      new RegExp(`Downloaded tarballs to satisfy ${pkgName} and 0 dependencies`)
    )
    t1.end()
  })
})

tap.test('rejection from call to external service', t1 => {
  const mockNpm = makeMockNpm()
  const dl = new Download(mockNpm)
  mockItemAgents.setTestConfig('getOperations', null)
  dl.exec(['no-such-pkg'], function(err, results) {
    t1.type(err, Error)
    t1.notOk(results)
    t1.end()
  })
})

tap.test('An optional dependency fetch fails', t1 => {
  const mockNpm = makeMockNpm()
  const dl = new Download(mockNpm)
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
  mockItemAgents.setTestConfig('getOperations', {
    'dummy1': injectedResults
  })
  dl.exec(['dummy1'], function(err, results) {
    t1.error(err, 'expect no error')
    t1.same(results, [ injectedResults ])
    t1.match(
      mockNpm.outputMsgs[0],
      /\(failed to fetch 1 optional packages\)/
    )
    t1.end()
  })
})

tap.test('A duplicate spec occurs', t1 => {
  const mockNpm = makeMockNpm()
  const dl = new Download(mockNpm)
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
  mockItemAgents.setTestConfig('getOperations', {
    [pkgName]: injectedResults[0],
    [dupSpec]: injectedResults[1]
  })
  dl.exec([pkgName, dupSpec], function(err, results) {
    t1.error(err, 'expect no error')
    t1.same(results, injectedResults)
    t1.match(
      mockNpm.outputMsgs[0],
      new RegExp(`Downloaded tarballs to satisfy ${pkgName} and 0 dependencies`)
    )
    t1.match(
      mockNpm.outputMsgs[0],
      new RegExp(`Nothing new to download for ${pkgName}@[^]1`)
    )
    t1.match(mockNpm.outputMsgs[0], /\(1 duplicate spec skipped\)/)
    t1.end()
  })
})

tap.test('OS raises EPERM on rm of temp directory', t1 => {
  const MockDl = t1.mock(n2sAssets.npmLib + '/download', {
    'rimraf': (dir, cb) => process.nextTick(() => {
      cb(Object.assign(new Error('OS is paranoid'), { code: 'EPERM' }))
    }),
    [n2sAssets.libDownload + '/item-agents.js']: mockItemAgents
  })
  const mockNpm = makeMockNpm({ 'dl-dir': n2sAssets.fs('pkgPath') })
  const pkgName = 'dummy1'
  const injectedData = [ { spec: pkgName, name: pkgName } ]
  mockItemAgents.setTestConfig('getOperations', {
    [pkgName]: injectedData
  })
  const dl = new MockDl(mockNpm)
  dl.exec([pkgName], function(err, results) {
    t1.error(err, 'expect no error')
    t1.same(results, [ injectedData ])
    t1.match(
      mockNpm.outputMsgs[0],
      new RegExp(`Downloaded tarballs to satisfy ${pkgName} and 0 dependencies`)
    )
    t1.end()
  })
})

tap.test('OS raises mystery error on rm of temp directory', t1 => {
  const MockDl = t1.mock(n2sAssets.npmLib + '/download', {
    'rimraf': (dir, cb) => process.nextTick(() => {
      cb(new Error('OS is spooky'))
    }),
    [n2sAssets.libDownload + '/item-agents.js']: mockItemAgents
  })
  const mockNpm = makeMockNpm({ 'dl-dir': n2sAssets.fs('pkgPath') })
  const pkgName = 'dummy1'
  const injectedData = [ { spec: pkgName, name: pkgName } ]
  mockItemAgents.setTestConfig('getOperations', {
    [pkgName]: injectedData
  })
  const dl = new MockDl(mockNpm)
  dl.exec([pkgName], function(err, results) {
    t1.error(err, 'expect no error')
    t1.same(results, [ injectedData ])
    t1.match(
      mockNpm.outputMsgs[0],
      new RegExp(`Downloaded tarballs to satisfy ${pkgName} and 0 dependencies`)
    )
    t1.end()
  })
})
