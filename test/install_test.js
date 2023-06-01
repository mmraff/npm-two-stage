const fs = require('fs')
const readdirConfig = {}
const path = require('path')
const { promisify } = require('util')

const rimrafAsync = promisify(require('rimraf'))
const tap = require('tap')

const makeAssets = require('./lib/make-assets')

const testRootName = 'tempAssets6'
let n2sAssets
let Install
let mockLog
let mockPacote
let mockNpmClass
let mockNpm

tap.before(() =>
  makeAssets(testRootName, 'install.js', { offliner: true })
  .then(assets => {
    n2sAssets = assets
    mockLog = require(assets.nodeModules + '/npmlog')
    mockNpmClass = require(assets.npmLib + '/npm')
    mockNpm = new mockNpmClass({
      cmd: 'install', cwd: assets.fs('installPath'), log: mockLog
    })
    mockNpm.config.load()

    // Install.completion uses readdir; we want to mock that. The only way we
    // can get away with that is by waiting until we don't need real readdir
    // anymore, then substituting the mock just before requiring install.js,
    // because install.js gets a promisified copy of it:
    const realReaddir = fs.readdir
    fs.readdir = (pathSpec, cb) => {
      const list = readdirConfig[pathSpec]
      if (!list) {
        const err = new Error(`no such file or directory, scandir '${pathSpec}'`)
        err.code = 'ENOENT'
        return cb(err)
      }
      cb(null, list)
    }
    Install = require(assets.npmLib + '/install')
    fs.readdir = realReaddir

    // This is needed to set up results for when install() fetches the manifest
    // of npm for an attempt at global installation:
    mockPacote = require(assets.nodeModules + '/pacote')
  })
)
tap.teardown(() => rimrafAsync(path.join(__dirname, testRootName)))

tap.test('exec() on installer instantiated without npm object', t1 => {
  const inst = new Install()
  inst.exec([], function(err) {
    t1.type(err, TypeError)
    t1.match(err, /Cannot read properties .+ \(reading 'globalDir'/)
    t1.end()
  })
})

tap.test('exec() on installer with no argument array', t1 => {
  const inst = new Install(mockNpm)
  inst.exec(null, function(err) {
    t1.type(err, TypeError)
    t1.match(err, /Cannot read properties .+ \(reading 'find'/)
    t1.end()
  })
})

// This section copied in from npm-cli-7.24.0 test suite for install,
// with modifications to make it compatible with our test context
//-----------------------------------------------------------------------------
tap.test('should install using Arborist', (t) => {
  const SCRIPTS = []
  let ARB_ARGS = null
  let REIFY_CALLED = false
  let ARB_OBJ = null

  const Install = t.mock(n2sAssets.npmLib + '/install', {
    [n2sAssets.nodeModules + '/@npmcli/run-script']: ({ event }) => {
      SCRIPTS.push(event)
    },
    [n2sAssets.nodeModules + '/@npmcli/arborist']: function (args) {
      ARB_ARGS = args
      ARB_OBJ = this
      this.reify = () => {
        REIFY_CALLED = true
      }
    },
    [n2sAssets.npmLib + '/utils/reify-finish.js']: (npm, arb) => {
      if (arb !== ARB_OBJ) {
        throw new Error('got wrong object passed to reify-finish')
      }
    },
  })

  const npm = new mockNpmClass({
    config: { dev: true },
    flatOptions: { global: false, auditLevel: 'low' },
    globalDir: 'path/to/node_modules/',
    prefix: 'foo',
     // mmraff added: needed by mock:
    cwd: n2sAssets.fs('installPath'), log: mockLog,
  })
  npm.config.load() // mmraff added: needed by mock
  const install = new Install(npm)

  t.test('with args', t => {
    install.exec(['fizzbuzz'], er => {
      if (er)
        throw er
      t.match(ARB_ARGS,
        { global: false, path: 'foo', auditLevel: null },
        'Arborist gets correct args and ignores auditLevel')
      t.equal(REIFY_CALLED, true, 'called reify')
      t.strictSame(SCRIPTS, [], 'no scripts when adding dep')
      t.end()
    })
  })

  t.test('just a local npm install', t => {
    install.exec([], er => {
      if (er)
        throw er
      t.match(ARB_ARGS, { global: false, path: 'foo' })
      t.equal(REIFY_CALLED, true, 'called reify')
      t.strictSame(SCRIPTS, [
        'preinstall',
        'install',
        'postinstall',
        'prepublish',
        'preprepare',
        'prepare',
        'postprepare',
      ], 'exec scripts when doing local build')
      t.end()
    })
  })

  t.end()
})

tap.test('should ignore scripts with --ignore-scripts', (t) => {
  const SCRIPTS = []
  let REIFY_CALLED = false

  const Install = t.mock(n2sAssets.npmLib + '/install', {
    [n2sAssets.npmLib + '/utils/reify-finish.js']: async () => {},
    [n2sAssets.nodeModules + '/@npmcli/run-script']: ({ event }) => {
      SCRIPTS.push(event)
    },
    [n2sAssets.nodeModules + '/@npmcli/arborist']: function () {
      this.reify = () => {
        REIFY_CALLED = true
      }
    },
  })
  const npm = new mockNpmClass({
    globalDir: 'path/to/node_modules/',
    prefix: 'foo',
    flatOptions: { global: false },
    config: {
      global: false,
      'ignore-scripts': true,
    },
    cwd: n2sAssets.fs('installPath'), log: mockLog, // mmraff added: needed by mock
  })
  npm.config.load() // mmraff added: needed by mock
  const install = new Install(npm)
  install.exec([], er => {
    if (er)
      throw er
    t.equal(REIFY_CALLED, true, 'called reify')
    t.strictSame(SCRIPTS, [], 'no scripts when adding dep')
    t.end()
  })
})
// END of section copied in from npm-cli-7.24.0 test suite for install
//-----------------------------------------------------------------------------

/*
  mmraff: Started to include the tests from npm-cli install test suite, as
  seen above, with the intent of substituting them for the ones I wrote;
  but soon had enough reason to decide that mine are more concise, have more
  assertions in some cases, and already provide 100% coverage.
*/


// This one hits lines 199-209, because !args.length && !isGlobalInstall && !ignoreScripts
tap.test('exec() on installer with empty argument array', t1 => {
  const inst = new Install(mockNpm)
  inst.exec([], function(err) {
    t1.equal(err, undefined)
    t1.end()
  })
})

tap.test('With a specific npm registry package spec', t1 => {
  const inst = new Install(mockNpm)
  inst.exec([ 'dummy@1.2.3' ], function(err) {
    t1.equal(err, undefined)
    t1.end()
  })
})

tap.test('With the `--dev` option', t1 => {
  mockNpm.config.dev = true
  mockLog.purge()
  const inst = new Install(mockNpm)
  inst.exec([ 'dummy@1.2.3' ], function(err) {
    t1.equal(err, undefined)
    const warning = mockLog.getList()[0]
    t1.equal(warning.level, 'warn')
    t1.match(warning.message, /\W--dev\W+option is deprecated/)
    mockNpm.config.dev = false
    t1.end()
  })
})

tap.test('Global installation cases', t1 => {
  mockNpm.config.set('global', true)
  mockNpm.config.load()
  t1.test('the project in the cwd', t2 => {
    const inst = new Install(mockNpm)
    inst.exec([], function(err) {
      t2.equal(err, undefined)
      t2.end()
    })
  })

  t1.test('an arbitrary registry package', t2 => {
    const inst = new Install(mockNpm)
    inst.exec([ 'dummy@1.2.3' ], function(err) {
      t2.equal(err, undefined)
      t2.end()
    })
  })

  t1.test('compatible version of npm is the target', t2 => {
    const spec = 'npm@7.25.0'
    mockPacote.setTestConfig({
      [spec]: {
        name: 'npm',
        version: '7.25.0',
        _from: 'npm@7.25.0',
        _resolved: 'https://registry.mock.com/npm/-/npm-7.25.0.tgz'
      }
    })
    const inst = new Install(mockNpm)
    inst.exec([ spec ], function(err) {
      t2.equal(err, undefined)
      t2.end()
    })
  })

  t1.test('incompatible version of npm is the target', t2 => {
    const spec = 'npm@99'
    mockPacote.setTestConfig({
      [spec]: {
        name: 'npm',
        version: '99.9.9',
        engines: {
          node: '>=23'
        },
        _from: 'npm@99',
        _resolved: 'https://registry.mock.com/npm/-/npm-99.9.9.tgz'
      }
    })
    mockLog.purge()
    const inst = new Install(mockNpm)
    inst.exec([ spec ], function(err) {
      t2.match(err, /Unsupported engine/)
      t2.equal(err.code, 'EBADENGINE')
      t2.equal(mockLog.getList().length, 0)

      // But now try to force it:
      mockNpm.config.force = true
      inst.exec([ spec ], function(err) {
        t2.equal(err, undefined)
        const warning = mockLog.getList()[0]
        t2.equal(warning.level, 'warn')
        t2.match(warning.message, /Forcing global npm install with incompatible version/)
        mockNpm.config.force = false
        t2.end()
        t1.end()
      })
    })
  })
})

tap.test('Offline install of arbitrary package', t1 => {
  mockNpm.config.set('offline', true)
  mockNpm.config.set('offline-dir', n2sAssets.fs('pkgPath'))
  mockNpm.config.set('global', false)
  mockNpm.config.load()
  const inst = new Install(mockNpm)
  inst.exec([ 'dummy@1.2.3' ], function(err) {
    t1.equal(err, undefined)
    mockNpm.config.set('offline', false)
    mockNpm.config.set('offline-dir', undefined)
    t1.end()
  })
})

/*
  The Installer completion method has not been modified at all; however, since
  there are changes to the containing file, it's reasonably arguable that there
  is an obligation to demonstrate that the file modifications have caused no
  change to the behavior of this method as it is in the original script.
*/
tap.test('completion cases', t1 => {
  // This is the only place where install.js uses readdir.
  // See notes about that in the makeAssets.then.

  // npm completion on Windows presents a complication:
  // the syntax requires '/', but result path components use '\\' separator
  // hence the apparent duplication with pathSpec and partialWord

  t1.test('partialWord is a URL', t2 => {
    const inst = new Install(mockNpm)
    inst.completion({ partialWord: 'https://whatever.net' })
    .then(result => {
      t2.same(result, [])
      t2.end()
    })
  })

  // Don't know that completion ever gets called with this kind of input, but
  // there's no specific checking for this, only the implicit 'else' of line 80
  t1.test('partialWord has no path delimiters', t2 => {
    const inst = new Install(mockNpm)
    const pathSpec = 'abc'
    inst.completion({ partialWord: pathSpec })
    .then(result => {
      t2.equal(result, undefined)
      t2.end()
    })
  })

  t1.test('partialWord is a path, but dirname does not exist in the filesystem', t2 => {
    const inst = new Install(mockNpm)
    const pathSpec = 'a' + path.sep + 'b'
    const partialWord = 'a/b'
    inst.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
      t2.end()
    })
  })

  // This hits alternative at line 87
  t1.test('partialWord is an entry at filesystem root', t2 => {
    const inst = new Install(mockNpm)
    const childName = 'abc'
    const pathSpec = path.sep + childName
    const partialWord = '/' + childName
    readdirConfig[ path.sep ]  = [ childName ]
    readdirConfig[ pathSpec ]  = []
    inst.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
      t2.end()
    })
  })

  // This hits line 92
  t1.test('partialWord looks like a child folder that does not exist', t2 => {
    const inst = new Install(mockNpm)
    const partialWord = 'a/b'
    readdirConfig[ 'a' ] = [ 'c' ]
    inst.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
      t2.end()
    })
  })

  // This hits the catch, covering line 101
  t1.test('partialWord is an only child that is not a folder', t2 => {
    const inst = new Install(mockNpm)
    const partialWord = 'a/b'
    readdirConfig[ 'a' ] = [ 'b' ]
    inst.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
      t2.end()
    })
  })

  t1.test('partialWord is a child with a sibling, but not a package folder', t2 => {
    const inst = new Install(mockNpm)
    const parentPath = 'a'
    const childName = 'b'
    const pathSpec = parentPath + path.sep + childName
    const partialWord = parentPath + '/' + childName
    readdirConfig[ parentPath ]  = [ childName ]
    readdirConfig[ pathSpec ] = [ 'whatever' ]
    inst.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
      t2.end()
    })
  })

  t1.test('partialWord is a folder that has a package.json', t2 => {
    const inst = new Install(mockNpm)
    const parentPath = 'a'
    const childName = 'b'
    const pathSpec = parentPath + path.sep + childName
    const partialWord = parentPath + '/' + childName
    readdirConfig[ parentPath ]  = [ childName ]
    readdirConfig[ pathSpec ] = [ 'package.json' ]
    inst.completion({ partialWord })
    .then(result => {
      t2.same(result, [ pathSpec ])
      t2.end()
    })
  })

  t1.end()
})

