const fs = require('fs')
const { rmSync } = fs
const path = require('path')

const tap = require('tap')

const makeAssets = require('./lib/make-assets')

const readdirConfig = {}
const fsMock = {
  ...fs,
  readdir: (pathSpec, cb) => {
    const list = readdirConfig[pathSpec]
    if (!list) {
      const err = Object.assign(
        new Error(`no such file or directory, scandir '${pathSpec}'`),
        { code: 'ENOENT' }
      )
      return cb(err)
    }
    cb(null, list)
  }
}
const testRootName = 'tempAssets6'
let n2sAssets
let Install
let mockLog
let mockPacote
let mockNpmClass

const makeMockNpm = (args = {}) => {
  const opts = {
    cmd: 'install', cwd: n2sAssets.fs('installPath'),
    log: mockLog,
    args
  }
  return new mockNpmClass(opts)
}

const usedMocksMsgs = []
const reportMockUsage = msg => usedMocksMsgs.push(msg)

tap.before(() =>
  makeAssets(
    testRootName, 'commands/install.js',
    {
      offliner: true,
      verbatim: {
        files: [
          'node_modules/@npmcli/config/lib/env-replace.js', // required by config, parse-field.js
          'node_modules/@npmcli/config/lib/parse-field.js', // required by config
          'node_modules/@npmcli/config/lib/type-defs.js', // required by definition.js, definitions.js, parse-field.js
          'node_modules/@npmcli/config/lib/umask.js', // required by type-defs.js, parse-field.js
        ],
        node_modules: [
          'npm-install-checks',
        ]
      }
    }
  )
  .then(assets => {
    n2sAssets = assets
    mockNpmClass = require(assets.npmLib + '/npm')
    mockLog = require(assets.npmLib + '/utils/log-shim')

    Install = tap.mock(n2sAssets.npmLib + '/commands/install', {
      'fs': fsMock,
      [assets.npmLib + '/utils/log-shim']: mockLog
    })

    // This is needed to set up results for when install() fetches the manifest
    // of npm for an attempt at global installation:
    mockPacote = require(n2sAssets.nodeModules + '/pacote')
    //process.on('used', reportMockUsage)
  })
)
tap.teardown(() => {
  //process.off('used', reportMockUsage)
  //console.log('$$$$$$ MOCKS OF CONCERN - USED: $$$$$$$$$$$$$$$$$$$$$$$')
  //console.log(usedMocksMsgs)
  return rmSync(
    path.join(__dirname, testRootName), { recursive: true, force: true }
  )
})

tap.test('exec() on installer instantiated without npm object', t1 => {
  const inst = new Install()
  return t1.rejects(
    inst.exec([]), /Cannot read properties .+ \(reading 'globalDir'/
  )
})

tap.test('exec() on installer with no argument array', t1 => {
  const mockNpm = makeMockNpm()
  const inst = new Install(mockNpm)
  return t1.rejects(
    inst.exec(null), /Cannot read properties .+ \(reading 'find'/
  )
})

// This section copied in from npm-cli-7.24.0 test suite for install,
// with modifications to make it compatible with our test context.
// Added further modifications to make it more easily comparable to the
// npm-cli-8.19.4 test suite for install.
//-----------------------------------------------------------------------------
tap.test('with args, dev=true', async t => {
  const SCRIPTS = []
  let ARB_ARGS = null
  let REIFY_CALLED = false
  let ARB_OBJ = null

  const Install = t.mock(n2sAssets.npmLib + '/commands/install', {
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

  // (The following derived from npm test developer comment:)
  // 'ignore-scripts' set to false here because CI calls tests with
  // `--ignore-scripts`, which config picks up from argv
  const npm = makeMockNpm({ 
    'ignore-scripts': false, 'audit-level': 'low', dev: true,
    prefix: path.resolve(t.testdir({}))
  })

  const install = new Install(npm)
  await install.exec(['fizzbuzz'])

  t.match(ARB_ARGS,
    { global: false, path: npm.prefix, auditLevel: null },
    'Arborist gets correct args and ignores auditLevel')
  t.equal(REIFY_CALLED, true, 'called reify')
  t.strictSame(SCRIPTS, [], 'no scripts when adding dep')
})

tap.test('without args', async t => {
  const SCRIPTS = []
  let ARB_ARGS = null
  let REIFY_CALLED = false
  let ARB_OBJ = null

  const Install = t.mock(n2sAssets.npmLib + '/commands/install', {
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

  const npm = makeMockNpm({
    'ignore-scripts': false, global: false, 'audit-level': 'low',
    prefix: path.resolve(t.testdir({})),
  })
  const install = new Install(npm)
  await install.exec([])
  t.match(ARB_ARGS, { global: false, path: npm.prefix })
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
})

tap.test('should ignore scripts with --ignore-scripts', async t => {
  const SCRIPTS = []
  let REIFY_CALLED = false
  const Install = t.mock(n2sAssets.npmLib + '/commands/install', {
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
  const npm = makeMockNpm({
    'ignore-scripts': true, prefix: path.resolve(t.testdir({})),
  })
  const install = new Install(npm)
  await install.exec([])
  t.equal(REIFY_CALLED, true, 'called reify')
  t.strictSame(SCRIPTS, [], 'no scripts when adding dep')
})

tap.test('should not install invalid global package name', async t => {
  const Install = t.mock(n2sAssets.npmLib + '/commands/install', {
    [n2sAssets.nodeModules + '/@npmcli/run-script']: () => {},
    [n2sAssets.npmLib + '/utils/reify-finish.js']: async () => {},
    [n2sAssets.nodeModules + '/@npmcli/arborist']: function (args) {
      throw new Error('should not reify')
    },
  })
  const npm = makeMockNpm({
    global: true, prefix: path.resolve(t.testdir({}))
  })
  const install = new Install(npm)
  // mmraff ADDITION: need this because our test Install does not derive
  // from BaseCommand:
  install.usageError = () => {
    return Object.assign(new Error('\nUsage:'), { code: 'EUSAGE' })
  }
  // END of ADDITION
  await t.rejects(
    install.exec(['']),
    /Usage:/,
    'should not install invalid package name'
  )
})

// END of section copied in from npm-cli-7.24.0 test suite for install
//-----------------------------------------------------------------------------


// This one hits lines nnn-nnn, because !args.length && !isGlobalInstall && !ignoreScripts
tap.test('exec() on installer with empty argument array', t1 => {
  const mockNpm = makeMockNpm()
  const inst = new Install(mockNpm)
  return t1.resolves(inst.exec([]))
})

tap.test('With a specific npm registry package spec', t1 => {
  const mockNpm = makeMockNpm()
  const inst = new Install(mockNpm)
  return t1.resolves(inst.exec([ 'dummy@1.2.3' ]))
})

/* --dev option treatment removed for npm v8
tap.test('With the `--dev` option', t1 => {
  const mockNpm = new mockNpmClass({
    cmd: 'install', cwd: n2sAssets.fs('installPath'), args: { dev: true }
  })
  mockLog.purge()
  const inst = new Install(mockNpm)
  return inst.exec([ 'dummy@1.2.3' ]).then(() => {
    const warning = mockLog.getList()[0]
    t1.equal(warning.level, 'warn')
    t1.match(warning.message, /\W--dev\W+option is deprecated/)
  })
})
*/

tap.test('Global installation cases', async t1 => {
  const mockNpm = makeMockNpm({ global: true })

  t1.test('the project in the cwd', t2 => {
    const inst = new Install(mockNpm)
    return t2.resolves(inst.exec([]))
  })

  t1.test('an arbitrary registry package', t2 => {
    const inst = new Install(mockNpm)
    return t2.resolves(inst.exec([ 'dummy@1.2.3' ]))
  })

  t1.test('compatible version of npm is the target', t2 => {
    const spec = 'npm@8.20.0'
    mockPacote.setTestConfig({
      [spec]: {
        name: 'npm',
        version: '8.20.0',
        _from: spec,
        _resolved: 'https://registry.mock.com/npm/-/npm-8.20.0.tgz'
      }
    })
    const inst = new Install(mockNpm)
    return t2.resolves(inst.exec([ spec ]))
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
        _from: spec,
        _resolved: 'https://registry.mock.com/npm/-/npm-99.9.9.tgz'
      }
    })
    mockLog.purge()
    const inst = new Install(mockNpm)
    return t2.rejects(
      inst.exec([ spec ]),
      { message: /Unsupported engine/, code: 'EBADENGINE' }
    )
    .then(() => {
      t2.equal(mockLog.getList().length, 0)

      // But now try to force it:
      mockNpm.config.set('force', true)
      return inst.exec([ spec ])
    })
    .then(() => {
      t2.match(
        mockLog.getList()[0], {
          level: 'warn',
          message: /Forcing global npm install with incompatible version/
        }
      )
    })
  })

  t1.end()
})

tap.test('Offline install of arbitrary package', async t1 => {
  const mockNpm = makeMockNpm({
    offline: true, 'offline-dir': n2sAssets.fs('pkgPath')
  })
  const inst = new Install(mockNpm)
  return t1.resolves(inst.exec([ 'dummy@1.2.3' ]))
})

// The Installer completion method has not been modified at all; however, since
// there are changes to the containing file, it's reasonably arguable that there
// is an obligation to demonstrate that the file modifications have caused no
// change to the behavior of this method as it is in the original script.
//
tap.test('completion cases', t1 => {
  const mockNpm = makeMockNpm()
  // This is the only place where install.js uses readdir.
  // See notes about that in the makeAssets.then.

  // npm completion on Windows presents a complication:
  // the syntax requires '/', but result path components use '\\' separator
  // hence the apparent duplication with pathSpec and partialWord

  t1.test('partialWord is a URL', t2 => {
    return Install.completion({ partialWord: 'https://whatever.net' })
    .then(result => {
      t2.same(result, [])
    })
  })

  // Don't know that completion ever gets called with this kind of input, but
  // there's no specific checking for this, only the implicit 'else' of line xx
  t1.test('partialWord has no path delimiters', t2 => {
    const pathSpec = 'abc'
    return Install.completion({ partialWord: pathSpec })
    .then(result => {
      t2.equal(result, undefined)
    })
  })

  t1.test('partialWord is a path, but dirname does not exist in filesystem', t2 => {
    const pathSpec = 'a' + path.sep + 'b'
    const partialWord = 'a/b'
    return Install.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
    })
  })

  // This hits alternative at line xx
  t1.test('partialWord is an entry at filesystem root', t2 => {
    const childName = 'abc'
    const pathSpec = path.sep + childName
    const partialWord = '/' + childName
    readdirConfig[ path.sep ]  = [ childName ]
    readdirConfig[ pathSpec ]  = []
    return Install.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
    })
  })

  // This hits line xx
  t1.test('partialWord looks like a child folder that does not exist', t2 => {
    const partialWord = 'a/b'
    readdirConfig[ 'a' ] = [ 'c' ]
    return Install.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
    })
  })

  // This hits the catch, covering line xxx
  t1.test('partialWord is an only child that is not a folder', t2 => {
    const partialWord = 'a/b'
    readdirConfig[ 'a' ] = [ 'b' ]
    return Install.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
    })
  })

  t1.test('partialWord is a child with a sibling, but not a package folder', t2 => {
    const parentPath = 'a'
    const childName = 'b'
    const pathSpec = parentPath + path.sep + childName
    const partialWord = parentPath + '/' + childName
    readdirConfig[ parentPath ]  = [ childName ]
    readdirConfig[ pathSpec ] = [ 'whatever' ]
    return Install.completion({ partialWord })
    .then(result => {
      t2.same(result, [])
    })
  })

  t1.test('partialWord is a folder that has a package.json', t2 => {
    const parentPath = 'a'
    const childName = 'b'
    const pathSpec = parentPath + path.sep + childName
    const partialWord = parentPath + '/' + childName
    readdirConfig[ parentPath ]  = [ childName ]
    readdirConfig[ pathSpec ] = [ 'package.json' ]
    return Install.completion({ partialWord })
    .then(result => {
      t2.same(result, [ pathSpec ])
    })
  })

  t1.end()
})
