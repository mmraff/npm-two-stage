const t = require('tap')
const { relative, resolve, basename, dirname, join } = require('path')
const fs = require('fs')
const mockGlobals = require('./fixtures/npmcli/mock-globals')
const makeAssets = require('./lib/make-assets')
const { copyFile } = fs.promises

const testRootName = 'tempAssets8'
let n2sAssets
let MockConfig
let mockLog
let MockDisplay
let MockLogFiles
let MockTimers
let Npm

const altLoadMockNpm = async (t, {
  load = true,
  globals = {},
  // test dirs
  prefixDir = {},
  homeDir = {},
  cacheDir = {},
  globalPrefixDir = { node_modules: {} },
  otherDirs = {},
} = {}) => {
  // These are globals manipulated by npm itself that we need to reset to their
  // original values between tests
  // TODO: find out if this ever serves a purpose for npm-two-stage
  const npmEnvs = Object.keys(process.env).filter(k => k.startsWith('npm_'))
  mockGlobals(t, {
    process: {
      title: process.title,
      execPath: process.execPath,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        COLOR: process.env.COLOR,
        // further, these are npm controlled envs that we need to zero out before
        // before the test. setting them to undefined ensures they are not set and
        // also returned to their original value after the test
        ...npmEnvs.reduce((acc, k) => {
          acc[k] = undefined
          return acc
        }, {}),
      },
    },
  })

  const testdir = t.testdir({
    home: homeDir,
    prefix: prefixDir,
    cache: cacheDir,
    global: globalPrefixDir,
    other: otherDirs,
  })
  const dirs = {
    testdir,
    prefix: join(testdir, 'prefix'),
    cache: join(testdir, 'cache'),
    globalPrefix: join(testdir, 'global'),
    home: join(testdir, 'home'),
    other: join(testdir, 'other'),
  }
  MockConfig.defaultCache = dirs.cache
  const withDirs = (v) => typeof v === 'function' ? v(dirs) : v
  const msgs = {
    display: null,
    logFiles: null,
    timers: null,
  }
  MockDisplay.ctorListener = inst => msgs.display = inst
  MockLogFiles.ctorListener = inst => msgs.logFiles = inst
  MockTimers.ctorListener = inst => msgs.timers = inst

  const mockedGlobals = mockGlobals(t, {
    'process.env.HOME': dirs.home,
    'process.env.PREFIX': dirs.globalPrefix,
    ...withDirs(globals),
    //...env,
  })

  const npm = new Npm()
  if (load) {
    await npm.load()
  }

  t.teardown(() => {
    if (npm) {
      npm.unload()
    }
  })

  return {
    npm,
    mockedGlobals,
    ...dirs,
    //...mockCommand,
    msgs
  }
}

const usedMocksMsgs = []
const reportMockUsage = msg => usedMocksMsgs.push(msg)

t.before(() =>
  makeAssets(
    testRootName, 'npm.js',
    {
      verbatim: {
        files: [
          'node_modules/@npmcli/config/lib/env-replace.js', // required by config, parse-field.js
          'node_modules/@npmcli/config/lib/parse-field.js', // required by config
          'node_modules/@npmcli/config/lib/type-defs.js', // required by definition.js, definitions.js, parse-field.js
          'lib/commands/get.js',
          'node_modules/@npmcli/config/lib/umask.js', // required by type-defs.js, parse-field.js
          'node_modules/@npmcli/config/lib/definitions/definition.js',
          'node_modules/@npmcli/config/lib/definitions/definitions.js',
          'node_modules/@npmcli/config/lib/definitions/index.js',
        ],
        node_modules: [
          'ci-info',
          'nopt'
        ]
      }
    }
  )
  .then(assets => {
    n2sAssets = assets
    mockLog = require(n2sAssets.npmLib + '/utils/log-shim.js')
    MockDisplay = require(n2sAssets.npmLib + '/utils/display.js')
    MockLogFiles = require(n2sAssets.npmLib + '/utils/log-file.js')
    MockTimers = require(n2sAssets.npmLib + '/utils/timers.js')
    return copyFile(
      resolve(__dirname, '../src/utils/cmd-list.js'),
      join(__dirname, n2sAssets.npmLib + '/utils/cmd-list.js')
    )
  })
  .then(() => {
    Npm = require(n2sAssets.npmLib + '/npm')
    MockConfig = require(n2sAssets.nodeModules + '/@npmcli/config')
    //process.on('used', reportMockUsage)
  })
)
t.teardown(() => {
  //process.off('used', reportMockUsage)
  //console.log('$$$$$$ MOCKS OF CONCERN - USED: $$$$$$$$$$$$$$$$$$$$$$$')
  //console.log(usedMocksMsgs)
  return fs.rmSync(
    join(__dirname, testRootName), { recursive: true, force: true }
  )
})

t.afterEach(t => {
  mockLog.purge()
})

// Derived from the test 'aliases and typos';
// testing aliases and typos is inappropriate in this suite
t.test('pass bad value to cmd', t => {
  t.throws(
    () => Npm.cmd('MONKEYS'),
    { message: 'Unknown command MONKEYS', code: 'EUNKNOWNCOMMAND' }
  )
  t.throws(() => Npm.cmd(''), { code: 'EUNKNOWNCOMMAND' })
  t.throws(() => Npm.cmd('birthday'), { code: 'EUNKNOWNCOMMAND' })
  t.end()
})

t.test('not yet loaded', async t => {
  const npm = new Npm()
  t.match(npm, {
    started: Number,
    command: null,
    config: {
      npmPath: n2sAssets.fs('npm'),
      loaded: false,
      get: Function,
      set: Function,
    },
    version: String,
  })
  t.throws(() => npm.config.set('foo', 'bar'))
  t.throws(() => npm.config.get('foo'))
  t.same(mockLog.getList(), [])
})

t.test('npm.load', async t => {
  t.afterEach(t => {
    mockLog.purge()
  })

  await t.test('load error', async t => {
    const npm = new Npm()
    const loadError = new Error('load error')
    npm.config.load = async () => {
      throw loadError
    }
    await t.rejects(
      () => npm.load(),
      /load error/
    )

    t.equal(npm.loadErr, loadError)
    npm.config.load = async () => {
      throw new Error('different error')
    }
    await t.rejects(
      () => npm.load(),
      /load error/,
      'loading again returns the original error'
    )
    t.equal(npm.loadErr, loadError)
  })

  await t.test('basic loading', async t => {
    const { npm, prefix: dir, cache, other, msgs } = await altLoadMockNpm(t, {
      prefixDir: { node_modules: {} },
      otherDirs: {
        newCache: {},
      },
    })
    const { display, logFiles, timers } = msgs

    t.equal(npm.loaded, true)
    t.equal(npm.config.loaded, true)
    t.equal(npm.config.get('force'), false)
    t.ok(npm.usage, 'has usage')

    t.match(npm, {
      flatOptions: {},
    })
    t.match(display.messages.filter(([n,p]) => p === 'npm:load'), [
      ['timing', 'npm:load', /Completed in [0-9.]+ms/],
    ])
    t.same(logFiles.messages, display.messages)

    mockGlobals(t, { process: { platform: 'posix' } })
    t.equal(resolve(npm.cache), resolve(cache), 'cache is cache')
    npm.cache = other.newCache
    t.equal(npm.config.get('cache'), other.newCache, 'cache setter sets config')
    t.equal(npm.cache, other.newCache, 'cache getter gets new config')
    t.equal(npm.lockfileVersion, 2, 'lockfileVersion getter')
    t.equal(npm.prefix, npm.localPrefix, 'prefix is local prefix')
    t.not(npm.prefix, npm.globalPrefix, 'prefix is not global prefix')
    npm.globalPrefix = npm.prefix
    t.equal(npm.prefix, npm.globalPrefix, 'globalPrefix setter')
    npm.localPrefix = dir + '/extra/prefix'
    t.equal(npm.prefix, npm.localPrefix, 'prefix is local prefix after localPrefix setter')
    t.not(npm.prefix, npm.globalPrefix, 'prefix is not global prefix after localPrefix setter')

    npm.prefix = dir + '/some/prefix'
    t.equal(npm.prefix, npm.localPrefix, 'prefix is local prefix after prefix setter')
    t.not(npm.prefix, npm.globalPrefix, 'prefix is not global prefix after prefix setter')
    t.equal(npm.bin, npm.localBin, 'bin is local bin after prefix setter')
    t.not(npm.bin, npm.globalBin, 'bin is not global bin after prefix setter')
    t.equal(npm.dir, npm.localDir, 'dir is local dir after prefix setter')
    t.not(npm.dir, npm.globalDir, 'dir is not global dir after prefix setter')

    npm.config.set('global', true)
    t.equal(npm.prefix, npm.globalPrefix, 'prefix is global prefix after setting global')
    t.not(npm.prefix, npm.localPrefix, 'prefix is not local prefix after setting global')
    t.equal(npm.bin, npm.globalBin, 'bin is global bin after setting global')
    t.not(npm.bin, npm.localBin, 'bin is not local bin after setting global')
    t.equal(npm.dir, npm.globalDir, 'dir is global dir after setting global')
    t.not(npm.dir, npm.localDir, 'dir is not local dir after setting global')

    npm.prefix = dir + '/new/global/prefix'
    t.equal(npm.prefix, npm.globalPrefix, 'prefix is global prefix after prefix setter')
    t.not(npm.prefix, npm.localPrefix, 'prefix is not local prefix after prefix setter')
    t.equal(npm.bin, npm.globalBin, 'bin is global bin after prefix setter')
    t.not(npm.bin, npm.localBin, 'bin is not local bin after prefix setter')

    mockGlobals(t, { process: { platform: 'win32' } })
    t.equal(npm.bin, npm.globalBin, 'bin is global bin in windows mode')
    t.equal(npm.dir, npm.globalDir, 'dir is global dir in windows mode')
  })

  await t.test('forceful loading', async t => {
    MockConfig.defaultCache = t.testdir()
    const npm = new Npm({ argv: [ '--force', '--color', 'always' ] })
    await npm.load()

    const logList = mockLog.getList()
    t.match(logList.filter(rec => rec.level === 'warn'), [
      {
        level: 'warn',
        prefix: 'using --force',
        message: 'Recommended protections disabled.'
      }
    ])
  })

  // Comment, not a TODO for me:
  // this set of tests is such a grab bag, I'm tempted to rewrite it...
  await t.test('node is a symlink', async t => {
    const node = process.platform === 'win32' ? 'node.exe' : 'node'
    const { npm, prefix, msgs } = await altLoadMockNpm(t, {
      prefixDir: {
        bin: t.fixture('symlink', dirname(process.execPath)),
      },
      globals: (dirs) => ({
        'process.env.PATH': resolve(dirs.prefix, 'bin'),
        'process.argv': [
          node,
          process.argv[1],
          '--usage',
          '--scope=foo',
          'token',
          'revoke',
          'blergggg',
        ],
      }),
    })
    const { display, logFiles } = msgs

    t.equal(npm.config.get('scope'), '@foo', 'added the @ sign to scope')
    t.match([
      ...display.messages.filter(([n,p]) => p === 'npm:load:whichnode'),
      ...mockLog.getList().filter(rec => rec.level === 'verbose')
        .map(rec => [ rec.prefix, rec.message ]),
      ...display.messages.filter(([n,p]) => p === 'npm:load'),
    ], [
      ['timing', 'npm:load:whichnode', /Completed in [0-9.]+ms/],
      ['node symlink', resolve(prefix, 'bin', node)],
      ['title', 'npm token revoke blergggg'],
      ['argv', '"--usage" "--scope" "foo" "token" "revoke" "blergggg"'],
      // The entry ['logfile', /logs-max:\d+ dir:.*/] is from actual log-file.js;
      // it's pointless to mock that.
      ['logfile', /.*-debug-0.log/],
      ['timing', 'npm:load', /Completed in [0-9.]+ms/],
    ])
    t.same(logFiles.messages, display.messages)
    t.equal(process.execPath, resolve(prefix, 'bin', node))

    const logMsgs = []
    const origConsoleLog = console.log
    const testConsoleLog = (...args) => logMsgs.push(args)
    console.log = testConsoleLog
    await npm.exec('ll', [])
    console.log = origConsoleLog

    t.equal(npm.command, 'll', 'command set to first npm command')
    t.equal(npm.flatOptions.npmCommand, 'll', 'npmCommand flatOption set')

    const ll = Npm.cmd('ll')
    t.same(logMsgs, [[ll.describeUsage]], 'print usage')
    npm.config.set('usage', false)

    display.messages.length = 0
    logFiles.messages.length = 0
    mockLog.purge()
    await npm.exec('get', ['scope', '\u2010not-a-dash'])

    t.strictSame([npm.command, npm.flatOptions.npmCommand], ['ll', 'll'],
      'does not change npm.command when another command is called')

    t.same(mockLog.getList(), [{
      level: 'error',
      prefix: 'arg',
      message: 'Argument starts with non-ascii dash, this is probably invalid: \u2010not-a-dash'
    }])
    t.match(display.messages, [
      [
        'timing',
        'command:config',
        /Completed in [0-9.]+ms/,
      ],
      [
        'timing',
        'command:get',
        /Completed in [0-9.]+ms/,
      ],
    ])
    t.same(logFiles.messages, display.messages)
    // TODO: Where would this output come from?
    //t.same(outputs, [['scope=@foo\n\u2010not-a-dash=undefined']])
  })

  await t.test('not otherwise covered', async t => {
    const { npm, msgs: { display } } = await altLoadMockNpm(t, {
      globals: {
        'process.argv': [
          process.execPath,
          process.argv[1],
        ],
      },
    })

    // MMR Note: no 2nd arg to npm.exec here.
    // This is the only test that covers that. (?!)
    await npm.exec('run')
    t.equal(npm.command, 'run-script', 'npm.command set to canonical name')
    t.match(
      display.messages.slice(-1),
      [[ 'timing', 'command:run', /Completed in [0-9]+ms/ ]]
    )

    display.messages.length = 0
    mockLog.purge()
    await npm.exec('ll', [])
    t.equal(npm.command, 'run-script', 'npm.command not changed by different exec')
    t.match(
      display.messages.slice(-1),
      [[ 'timing', 'command:ll', /Completed in [0-9]+ms/ ]]
    )
    // outputs removed from here. What was being tested was the
    // "script" detection and info output done by the actual run-script
    // command, which is not implemented in the mock.

    // MMR added:
    t.equal(npm.isShellout, true) // because it says so in the run-script mock!
    t.type(npm.noColorChalk, 'Chalk')
    t.type(npm.chalk, 'Chalk')
    t.equal(npm.npmRoot, n2sAssets.fs('npm'))
    t.equal(npm.localPackage, 'MOCK_CONFIG_DUMMY_LOCALPACKAGE')
  })
})

t.test('set process.title', async t => {
  // This one gives no coverage addition.
  t.test('basic title setting', async t => {
    const { npm } = await altLoadMockNpm(t, {
      globals: {
        'process.argv': [
          process.execPath,
          process.argv[1],
          '--usage',
          '--scope=foo',
          'ls',
        ],
      },
    })

    t.equal(npm.title, 'npm ls')
    t.equal(process.title, 'npm ls')
  })

})

t.test('debug log', async t => {
  t.test('can load with bad dir', async t => {
    MockLogFiles.ctorListener = inst => inst.setOpenError()

    MockConfig.defaultCache = t.testdir()

    const npm = new Npm()
    await t.resolves(npm.load(), 'loads with invalid logs dir')

    t.equal(npm.logFiles.length, 0, 'no log files array')
  })
})

t.test('cache dir', async t => {
  t.test('creates a cache dir', async t => {
    MockConfig.defaultCache = t.testdir()
    const { npm } = await altLoadMockNpm(t)

    t.ok(fs.existsSync(npm.cache), 'cache dir exists')
  })

  t.test('can load with a bad cache dir', async t => {
    const { npm, cache } = await altLoadMockNpm(t, {
      load: false,
      // The easiest way to make mkdir(cache) fail is to make it a file.
      // This will have the same effect as if its read only or inaccessible.
      cacheDir: 'A_TEXT_FILE',
    })
    await t.resolves(npm.load(), 'loads with cache dir as a file')

    t.equal(fs.readFileSync(cache, 'utf-8'), 'A_TEXT_FILE')
  })
})

t.test('timings', async t => {
  t.test('gets/sets timers', async t => {
    const { npm, msgs } = await altLoadMockNpm(t, { load: false })
    const { display, logFiles, timers } = msgs

    process.emit('time', 'foo')
    process.emit('time', 'bar')
    t.match(npm.unfinishedTimers.get('foo'), Number, 'foo timer is a number')
    t.match(npm.unfinishedTimers.get('bar'), Number, 'foo timer is a number')
    process.emit('timeEnd', 'foo')
    process.emit('timeEnd', 'bar')
    process.emit('timeEnd', 'baz')
    // npm timer is started by default
    process.emit('timeEnd', 'npm')
    t.match(display.messages, [
      [ 'timing', 'foo', /Completed in [0-9]+ms/ ],
      [ 'timing', 'bar', /Completed in [0-9]+ms/ ],
      [ 'timing', 'npm', /Completed in [0-9]+ms/ ],
    ])
    t.same(logFiles.messages, display.messages)
    // The message being tested for is from actual timers.js here;
    // we don't mock that.
    //t.match(logs.silly, [[
    //  'timing',
    //  "Tried to end timer that doesn't exist:",
    //  'baz',
    //]])
    t.notOk(npm.unfinishedTimers.has('foo'), 'foo timer is gone')
    t.notOk(npm.unfinishedTimers.has('bar'), 'bar timer is gone')
    t.match(npm.finishedTimers, { foo: Number, bar: Number, npm: Number })
  })

  t.test('writes timings file', async t => {
    const { npm, cache, msgs } = await altLoadMockNpm(t, {
      globals: {
        'process.argv': [
          process.execPath,
          process.argv[1],
          '--timing', 'true',
        ],
      },
    })
    const { display, timers } = msgs

    process.emit('time', 'foo')
    process.emit('timeEnd', 'foo')
    process.emit('time', 'bar')
    npm.writeTimingFile()
    t.match(npm.timingFile, cache)
    t.match(npm.timingFile, /-timing.json$/)
    // metadata:
    t.match(timers.messages, [{
      id: basename(npm.logPath).slice(0, -1),
      command: [ '--timing', 'true' ],
      logfiles: npm.logFiles,
      version: String,
    }])
    // unfinishedTimers:
    t.same(display.messages.filter(([n,p] ) => p === 'bar'), [])
    t.same(display.messages.filter(([n,p] ) => p === 'npm'), [])
    // timers (finished):
    t.match(
      display.messages.filter(([n,p] ) => p === 'npm:load'),
      [[ 'timing', 'npm:load', /Completed in [0-9]+ms/ ]]
    )
    t.match(
      display.messages.filter(([n,p] ) => p === 'foo'),
      [[ 'timing', 'foo', /Completed in [0-9]+ms/ ]]
    )
  })
})

// NOTE: type checking is NOT implemented in the config mock!
t.test('Added definitions', async t => {
  const { npm } = await altLoadMockNpm(t)

  t.hasOwnProps(
    npm.config.definitions,
    [ 'offline-dir', 'dl-dir', 'package-json', 'lockfile-dir' ]
  )
  // Cause the flatten function to be used:
  npm.config.set('offline-dir', 'a/b')
  npm.config.set('dl-dir', 'c/d')
  npm.config.set('package-json', 'e/f')
  npm.config.set('lockfile-dir', 'g/h')
  t.match(npm.flatOptions, {
    offlineDir: 'a/b',
    dlDir: 'c/d',
    packageJson: 'e/f',
    lockfileDir: 'g/h'
  })
})

t.test('Output-related stuff', async t => {
  const { npm } = await altLoadMockNpm(t)
  const msgs = [
    'hickory-dickory-dock',
    'mary had a little lamb',
    { name: 'BOB', hobbies: 10 }
  ]

  const logMsgs = []
  const origConsoleLog = console.log
  const newConsoleLog = (...args) => {
    t.equal(mockLog.progressIsShowing(), false)
    logMsgs.push(args)
  }

  // After each time flushOutput() is called, there should be
  // nothing left in npm's #outputBuffer
  console.log = newConsoleLog
  npm.flushOutput()
  console.log = origConsoleLog
  t.same(logMsgs, [], 'nothing in output buffer yet')

  for (const item of msgs) {
    npm.outputBuffer(item)
  }
  t.ok(mockLog.progressIsShowing())
  console.log = newConsoleLog
  npm.flushOutput()
  console.log = origConsoleLog
  t.same(logMsgs, msgs.map(el => [ el ]))

  // When the 'json' option is set, output should be in JSON form
  const jsonError = { name: 'Mock', skill: 'mocking' }
  logMsgs.length = 0
  npm.config.set('json', true)
  for (const item of msgs) {
    npm.outputBuffer(item)
  }
  console.log = newConsoleLog
  npm.flushOutput(jsonError)
  console.log = origConsoleLog
  // The reducer function in npm.flushOutput eliminates any string-type item
  // that cannot be parsed as JSON; hence we lose the first two elements.
  // The contents of the remaining items are spread to make a flat object.
  // The name in the 'jsonError' arg overrides the name in the outputBuffer item.
  t.same(logMsgs, [[ JSON.stringify({ ...msgs[2], ...jsonError }, null, 2) ]])

  logMsgs.length = 0
  console.log = newConsoleLog
  npm.flushOutput(jsonError)
  console.log = origConsoleLog
  t.same(logMsgs, [[ JSON.stringify({ ...jsonError }, null, 2) ]])

  const errItems = [ 'brave', 'new', 'world' ]
  const origConsoleErr = console.error
  t.ok(mockLog.progressIsShowing())
  logMsgs.length = 0
  console.error = newConsoleLog
  npm.outputError(errItems)
  console.error = origConsoleErr
  t.same(logMsgs, [ [ errItems ] ])

  t.end()
})
