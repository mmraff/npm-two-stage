const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const execAsync = promisify(require('child_process').exec)
const copyFileAsync = promisify(fs.copyFile)
const lstatAsync = promisify(fs.lstat)
const mkdirAsync = promisify(fs.mkdir)
const readdirAsync = promisify(fs.readdir)
const readFileAsync = promisify(fs.readFile)

const rimrafAsync = promisify(require('rimraf'))

const tap = require('tap')

const graft = require('./lib/graft')
const gitServer = require('./lib/git-server')
const remoteServer = require('./lib/remote-server')
const arbFixtures = './fixtures/arborist/fixtures'
const { registry } = require(arbFixtures + '/registry-mocks/server.js')
const mockRegistryProxy = require('./lib/mock-server-proxy')

// Where the test npm will be installed
const staging = path.resolve(__dirname, 'staging')
const stagedNpmDir = path.join(
  staging, process.platform == 'win32' ? '' : 'lib', 'node_modules/npm'
)
const testNpm = path.join(
  staging, process.platform == 'win32' ? '' : 'bin', 'npm'
)

// Copy all the npm-two-stage source files into the staged npm
// (overwriting original files as the case may be)
function applyN2SFiles() {
  const src = path.resolve(__dirname, '../src')
  const dest = path.join(stagedNpmDir, 'lib')
  let npmLibList
  return readdirAsync(dest)
  .then(list => {
    npmLibList = list
    return readdirAsync(src).then(items => nextItem('', items, 0))
  })

  function nextItem(offset, list, i) {
    if (i >= list.length) return Promise.resolve()
    const item = list[i]
    const srcItemPath = path.join(src, offset, item)
    return lstatAsync(srcItemPath).then(srcStats => {
      const target = path.join(dest, offset, item)
      let p
      if (srcStats.isDirectory()) {
        p = offset == '' && !npmLibList.includes(item) ?
          graft(srcItemPath, dest) :
          readdirAsync(srcItemPath).then(entries =>
            mkdirAsync(target)
            .catch(err => {
              if (err.code != 'EEXIST') throw err
            })
            .then(() => nextItem(path.join(offset, item), entries, 0))
          )
      }
      else if (srcStats.isFile())
        // We don't do COPYFILE_EXCL here because we don't do backups in this
        // sandboxed test situation, we simply overwrite
        p = copyFileAsync(srcItemPath, target)
      else {
        // This should never happen in this context!
        // But potential harm is neutralized
        p = Promise.resolve()
        console.warn(
          'copyEntries: Not a regular file or a directory, omitting',
          srcItemPath
        )
      }
      return p.then(() => nextItem(offset, list, i+1))
    })
  }
}

const makeProjectDirectory = (t, dlDirName, installDirName) => {
  return t.testdir({
    [dlDirName]: {},
    [installDirName]: {
      'package.json': JSON.stringify({
        name: installDirName, version: '1.0.0'
      })
    }
  })
}

// TODO: modify this according to what I developed at work for npm2stage-v6
// (cmd.js module, cmd.execute)
const runNpmCmd = async (npmBin, cmd, argList, opts) => {
  // For almost all calls, we need npm to be configured with
  //   globalPrefix=staging, registry=registry, ...
  // If environment var PREFIX is set, npm load will set globalPrefix to that.
  // NOTE that in download.js, we set the cache to a custom location:
  // 'dl-temp-cache' in the dl-dir.
  if (!argList) argList = []
  argList.push('--registry=' + registry)
  if (!opts) opts = { env: {} }
  if (!opts.env) opts.env = {}
  // So far, it seems there's no need to do anything special on Windows...
  if (process.platform != 'win32') {
    opts.env.PATH = process.env.PATH
    opts.env.SHELL = process.env.SHELL
  }
  opts.env.PREFIX = staging
  return execAsync([ npmBin, cmd ].concat(argList).join(' '), opts)
  // resolves to { stdout, stderr };
  // rejects as error e with e.stdout and e.stderr
}

const RE_RMV_PROTO = /^[a-z]+:\/\/(.+)$/
const RE_TARBALL_EXT = /\.(tar\.gz|tgz)$/

const checkDownloads = (t, pkgMap, dlPath) =>
  readdirAsync(dlPath).then(list => {
    const expectedItems = [ 'dl-temp', 'dltracker.json' ]
    for (const name in pkgMap) {
      const versions = pkgMap[name]
      for (const v in versions) {
        if (versions[v].inBundle) continue
        const raw = versions[v].rawSpec
        const fname = encodeURIComponent(
          raw ? (RE_RMV_PROTO.exec(raw)[1] + (RE_TARBALL_EXT.test(raw) ? '' : '.tar.gz'))
          : `${name}-${v}.tar.gz`
        )
        expectedItems.push(fname)
      }
    }
    // It's no good using t1.same() on an array unless the sequence of 'found'
    // matches that of 'wanted'.
    t.same(
      list.sort(), expectedItems.sort(),
      'download dir contains all expected items'
    )
  })

const checkProjectRootPostInstall = (t, projectRoot) =>
  readdirAsync(projectRoot).then(list => {
    const expected = [ 'node_modules', 'package-lock.json', 'package.json' ]
    t.same(list, expected, 'Nothing more or less than what is expected')
  })

const RE_NS = /^(@[^/]+)\/([^/]+)$/

const addPathToCheckFor = (pkgName, pathParts, pathMap) => {
  if (pathParts.length) pathParts.push('node_modules')
  const matches = RE_NS.exec(pkgName)
  if (matches) {
    // If pathParts is empty, this results in addition of the namespace to
    // the top level list:
    const dir = pathParts.join('/')
    let dirSet = pathMap[dir]
    if (!dirSet) dirSet = pathMap[dir] = new Set()
    dirSet.add(matches[1])
    pathParts.push(matches[1])
  }
  if (pathParts.length) {
    const dir = pathParts.join('/')
    let dirSet = pathMap[dir]
    if (!dirSet) dirSet = pathMap[dir] = new Set()
    dirSet.add(matches ? matches[2] : pkgName)
    return dir
  }
  return ''
}

// Verify that every package mentioned in pkgMap is present somewhere under
// the given basePath
const checkInstalled = (t, pkgMap, basePath, opts) => {
  const node_modules = path.join(basePath, 'node_modules')
  const pathMap = {}
  const topLevel = pathMap[''] = new Set()
  opts = opts || {}

  const checkDirs = (dirs, i) => {
    if (i >= dirs.length) return Promise.resolve()
    const dir = dirs[i]
    return readdirAsync(path.join(node_modules, dir))
    .then(list => {
      const found = list.filter(
        name => (name != '.package-lock.json' && name != '.bin')
      )
      const wanted = Array.from(pathMap[dir])
      t.same(
        found.sort(), wanted.sort(),
        `Found all expected packages at ${dir}`
      )
    })
    .then(() => checkDirs(dirs, i + 1))
  }
  // Collect lists of package names that we should find in subdirectories
  // under the project root
  // TODO: Arguably, this is complex enough to merit its own test suite.
  for (const name in pkgMap) {
    const versions = pkgMap[name]
    for (const v in versions) {
      const pkg = versions[v]
      let parts = []
      /*
      'parent' is not a package name, but a partial path. The idea is to follow
      what they do with the 'packages' entries in the package-lock:
        [[@ns/]ancestor/node_modules/]*[@ns/]parent
      So we will join(installDir, 'node_modules', theAbove, 'node_modules'),
      and expect readdirAsync to give us the associated list
      (once .package-lock.json and .bin are removed)
      */
      if (pkg.parent) parts.push(pkg.parent)
      const dir = addPathToCheckFor(name, [...parts], pathMap)
      if (!dir) topLevel.add(name)
      if (pkg.inBundle && pkg.deps) {
        for (const dep in pkg.deps)
          addPathToCheckFor(dep, [...parts], pathMap)
      }
    }
  }
  if (opts.debug) console.log(opts.debug, pathMap)
  const paths = Object.keys(pathMap)
  return checkProjectRootPostInstall(t, basePath)
  .then(() => checkDirs(paths, 0))
}

const getJsonFileData = filepath => {
  return readFileAsync(filepath, { encoding: 'utf8' }).then(str => {
    // Strip BOM, if any
    if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1)
    return JSON.parse(str)
  })
}

const checkPackageLock = (t, installPath, pkgs, tgtName, opts) =>
  getJsonFileData(path.join(installPath, 'package-lock.json')).then(pkgLk => {
    // TODO: get the integrity value from the previous run of npm install,
    // and store it in a convenient place in pkgs;
    // when we get here, add it to the object to compare
    opts = opts || {}
    if (!opts.omit) opts.omit = []
    // TODO: if we can't rely on the order of versions in pkgs[tgtName] to be
    // the same as what's in the code, then we'll have to add a flag to the
    // pkgs record!
    const tgtVer = Object.keys(pkgs[tgtName])[0]
    const rawSpec = pkgs[tgtName][tgtVer].rawSpec
    const expected = {
      // npm adds the prefix '^' to exact target specs
      '': { dependencies: { [tgtName]: rawSpec || ('^' + tgtVer) } }
    }
    for (const name in pkgs) {
      const versions = pkgs[name]
      for (const v in versions) {
        const data = versions[v]
        let modPath = 'node_modules/' + name
        if (data.parent) modPath = `node_modules/${data.parent}/${modPath}`
        expected[modPath] = { version: v }
        // TODO: this is where we'd apply 'integrity'
        if (data.deps)
          expected[modPath].dependencies = data.deps
        if (data.peerDeps)
          expected[modPath].peerDependencies = data.peerDeps
        if (data.peer && !opts.omit.includes('peer'))
          expected[modPath].peer = data.peer
      }
    }
    t.match(
      pkgLk.packages, expected, 'expected content is in package-lock.json'
    )
  })

const testCacheName = 'tempcache'

const repoName1 = 'top-repo'
const repoCfg1 = {
  devDeps: {
    'abbrev': '1.1.1',
  },
  scripts: {
    prepare: 'node prepare.js',
    test: 'node index.js',
  },
  items: [
    {
      filename: '.gitignore',
      content: 'index.js',
      message: 'ignore file'
    },
    {
      filename: 'prepare.js',
      content: [
        "const fs = require('fs')",
        "const { join } = require('path')",
        "require('abbrev')",
        "fs.writeFileSync(join(__dirname, 'index.js'), 'console.log(\"ok\")')"
      ].join('\n'),
      message: 'prepare script'
    },
    {
      filename: 'README.md',
      content: 'This is documentation.',
      message: 'added documentation',
      version: '1.0.0'
    },
    {
      filename: 'README.md',
      content: 'This is UPDATED documentation.',
      message: 'updated docs'
    }
  ]
}
const gitHostPort = 19418
const gitHostBaseName = 'gitBase'
let gitHostBase

const remoteBaseRelPath = 'fixtures/data'
let remotePort
let remoteBase

tap.before(() => {
  const rootPath = tap.testdir({
    [testCacheName]: {}
  })
  const cache = path.resolve(rootPath, testCacheName)
  const pkgDrop = path.resolve(__dirname, 'npm_tarball_dest')
  let pkgPath
  // NOTE: formerly had gitHostBase in the tap.testdir; but was getting EBUSY
  // error from rmdir on teardown, even though the tap doc for fixtures says
  // "The fixture directory cleanup will always happen after any
  //  user-scheduled t.teardown() functions, as of tap v14.11.0."
  // Funny, now that removal is done *during* teardown, the problem is gone.
  gitHostBase = path.resolve(staging, 'srv', gitHostBaseName)
  remoteBase = path.resolve(__dirname, remoteBaseRelPath)

  return mkdirAsync(pkgDrop)
  .then(() => execAsync('npm root -g')).then(({ stdout, stderr }) => {
    const npmDir = path.join(stdout.trim(), 'npm')
    //console.log('live npm path is', npmDir)
    const npm = require(npmDir)
    return npm.load().then(() => {
      npm.config.set('cache', cache)
      npm.config.set('pack-destination', pkgDrop)
      npm.log.level = 'warn' // 'error', 'silent'
      const packAsync = promisify(npm.commands.pack)
      return packAsync([path.join(__dirname, '../node_modules/npm')])
    })
    .then(() => readdirAsync(pkgDrop))
    .then(list => {
      if (!list.length) throw new Error('npm tarball not found at ' + pkgDrop)
      pkgPath = path.join(pkgDrop, list[0])
    })
    .then(() => rimrafAsync(staging))
    .then(() => mkdirAsync(staging))
    .then(() => mkdirAsync(gitHostBase, { recursive: true }))
    .then(() => {
      npm.globalPrefix = staging // Really important!
      npm.config.set('global', true)
      npm.config.set('fund', false)
      const installAsync = promisify(npm.commands.install)
      return installAsync([pkgPath])
    })
    .finally(() => {
      npm.config.set('global', false)
    })
  })
  // The executable of the test installation is now at testNpm;
  // the target location for npm-two-stage is at stagedNpmDir.
  .then(() => {
    console.log('npm installation seems to have been successful...')
    return rimrafAsync(pkgDrop).then(() => applyN2SFiles())
  })
  .then(() => mockRegistryProxy.start())
  .then(() => gitServer.start(gitHostPort, gitHostBase))
  .then(() => gitServer.createRepo(repoName1, repoCfg1, testNpm))
  .then(() => remoteServer.start(remoteBase/*, { debug: true }*/))
  .then(num => remotePort = num)
})
tap.teardown(() => {
  return new Promise(resolve => mockRegistryProxy.stop(() => resolve()))
  .then(() => gitServer.stop())
  .then(() => remoteServer.stop())
  .then(() => rimrafAsync(staging))
})

// Path component names we'll be using a lot
const dlDirName = 'tarballs'
const installDirName = 'install-tgt'

// TODO: Decide whether to keep this test.
// It's good for nothing more than proving that an error from pacote gets
// passed through the download() callback.
// Are there any other pacote errors that we can cause in a test?
// Case 1: request for non-existent package
tap.test('1', t1 => {
  const targetDir = t1.testdir()
  // Note: npm-package-arg has no problem with a name like 'OMGZ!',
  // even though npm would count it as illegal
  t1.rejects(
    runNpmCmd(testNpm, 'download', ['OMGZ!'], { cwd: targetDir }),
    /npm ERR! 404 Not Found/
  )
  t1.end()
})

// TODO? a package that refuses to install because wrong os?

// Case 2: package with no regular deps
// TODO: add at least one other no-dep pkg to the command line
tap.test('2', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  // acorn v4 has no regular dependencies.
  // The mock registry packument for acorn lists higher versions than the
  // tarballs it has available, so we must be careful with the spec we use.
  const spec = '"acorn@<4.0.5"'
  return runNpmCmd(testNpm, 'download', [ '--dl-dir='+dlPath, spec ])
  .then(() => readdirAsync(dlPath))
  .then(list => {
    t1.equal(list.length, 3, 'Nothing more or less than what is expected')
    t1.ok(list.includes('acorn-4.0.4.tar.gz'), 'Target package tarball was downloaded')
    t1.ok(list.includes('dltracker.json'), 'dltracker.json file was created')
    t1.ok(list.includes('dl-temp'), 'temp dir for cache was created')

    return runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir='+dlPath, spec ], { cwd: installPath }
    )
  })
  .then(() => readdirAsync(path.join(installPath, 'node_modules')))
  .then(list => {
    t1.ok(list.includes('acorn'))
    // TODO: ???
  })
  .then(() => {
    /*
      TODO: verify somehow (maybe there's a convenient npm.command that does that?)
      * look for the installed package in the dependencies of the package.json,
        and verify the spec
      * verify the package is in node_modules
      * validate the package-lock.json somehow?
      The following has output that looks like the contents of a simple
      package-lock.json file - is that where ls gets its info from?
      In which case, why not just examine the contents of the package-lock.json?
    */
    return runNpmCmd(
      testNpm, 'ls', [ '--all', '--json' ], { cwd: installPath }
    )
  })
  /*
    dl 'rimraf@2.4.3' works (at last), and its dependency tree is retrieved
    alright, but...
    we requested rimraf (a) with no spec, and (b) with a partial spec;
    in both cases, the test install failed with a 404 error.
    It turns out that there's a "packument" for every package in the content
    directory of registry-mocks, but the registry directory for the package
    does not contain every version listed; so if the request is not specific,
    the mock registry tries to serve the latest that matches the spec, and
    fails when the matching version is not present.
    Then it's also possible that npm is walking up to the npm-two-stage root,
    reading what's in the package.json there, and figuring that into it's
    decision about what to request...
    TODO:
    * pick a package from the arborist registry mocks that's not in
      npm-two-stage/node_modules (if any), so that we don't get that confusion
      that we saw when . See if our test setup can handle those cases.
    * verify that the pkg directory contains the expected tarballs, with
      .tar.gz extension.
    * verify that the pkg directory contains a dltracker.json file.
    * Run npm install --offline from the pkg directory, and verify the
      result (somehow - look to the npm tests for an example to follow).
    * Do all of the above for each kind of spec.
    * Do a non-offline install (perhaps before anything else).
    * Do a test to prove that npm download does not care about the engine
      required by a package.
  */
  .finally(() => {
    t1.end()
  })
/*
  TODO:
  * Set up the integration test suite to be done without coverage!
    (Coverage is covered by unit test suites.)
    Instead, investigate npm tests for the cases to be addressed, then add
    our own for download.
  * have a directory with a package.json as a fixture
  * copy it to a test base directory for each test
  * process.chdir() to it before running a command
  * See this directory for what packages are available through the mock registry:
      fixtures/arborist/fixtures/registry-mocks/content/
*/
/*
  LESSON:
  * npm commands run programmatically *must* be given an array as the 1st arg
    (containing args meant to be passed to the command), and *must* be given
    a callback (unless promisified).
  * If you want to see `testNpm root -g` give the staging location,
      testNpm.config.set('global', true)
  * If you want to see `testNpm root` give the root of a specific project,
      process.chdir(<PROJECT_PATH>)
*/
})

// Case 3: package with a flat set of regular deps
// TODO: rewrite the treatment of this case to be like case 4
tap.test('3', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const tgtName = 'readable-stream'
  const tgtVer = '2.0.2'
  const spec = `"${tgtName}@${tgtVer}"`
  // This information is in the manifest of the target package, available from
  // the mock registry, but it would make a very busy code block to get it from
  // there, so we'll keep it simple by reproducing here.
  // The reason that the property names are not the same as in a package-lock
  // file is that we must modify the object contents radically anyway, because
  // in the package-lock, the properties corresponding to package names are
  // relative paths with a base of 'node_modules/'; meanwhile, we really want
  // bare package names for our convenience in the operations below.
  const pkgs = {
    [tgtName]: {
      [tgtVer]: {
          deps: {
          'core-util-is': '~1.0.0',
          'inherits': '~2.0.1',
          'isarray': '0.0.1',
          'process-nextick-args': '~1.0.0',
          'string_decoder': '~0.10.x',
          'util-deprecate': '~1.0.1'
        }
      }
    },
    'core-util-is': { '1.0.2': {} },
    'inherits': { '2.0.4': {} },
    'isarray': { '0.0.1': {} },
    'process-nextick-args': { '1.0.7': {} },
    'string_decoder': { '0.10.31': {} },
    'util-deprecate': { '1.0.2': {} }
  }
  return runNpmCmd(testNpm, 'download', [ '--dl-dir='+dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install',
    [ '--offline', '--offline-dir='+dlPath, spec ], { cwd: installPath }
  ))
  .then(() => checkInstalled(t1, pkgs, installPath))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
  .finally(() => {
    t1.end()
  })
})

// Case 4: package with a non-flat tree of regular deps
tap.test('4', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const tgtName = 'normalize-package-data'
  const tgtVer = '2.5.0'
  const spec = `"${tgtName}@${tgtVer}"`
  const pkgs = {
    [tgtName]: {
      [tgtVer]: {
         deps: {
          'hosted-git-info': '^2.1.4',
          'resolve': '^1.10.0',
          'semver': '2 || 3 || 4 || 5',
          'validate-npm-package-license': '^3.0.1'
        }
      }
    },
    'hosted-git-info': { '2.8.8': {} },
    'path-parse': { '1.0.6': {} },
    'resolve': {
      '1.17.0': { deps: { 'path-parse': '^1.0.6' } }
    },
    'semver': { '5.7.1': {} },
    'spdx-correct': {
      '3.1.1': {
        deps: {
          'spdx-expression-parse': '^3.0.0',
          'spdx-license-ids': '^3.0.0'
        }
      }
    },
    'spdx-exceptions': { '2.3.0': {} },
    'spdx-expression-parse': {
      '3.0.1': {
        deps: {
          'spdx-exceptions': '^2.1.0',
          'spdx-license-ids': '^3.0.0'
        }
      }
    },
    'spdx-license-ids': { '3.0.6': {} },
    'validate-npm-package-license': {
      '3.0.4': {
        deps: {
          'spdx-correct': '^3.0.0',
          'spdx-expression-parse': '^3.0.0'
        }
      }
    }
  }
  return runNpmCmd(testNpm, 'download', [ '--dl-dir='+dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install',
    [ '--offline', '--offline-dir='+dlPath, spec ], { cwd: installPath }
  ))
  .then(() => checkInstalled(t1, pkgs, installPath))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
  .finally(() => {
    t1.end()
  })
})

// Case 5: (scoped) package with scoped regular dep
tap.test('5', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const tgtName = '@types/react'
  const tgtVer = '17.0.0'
  const spec = `"${tgtName}@${tgtVer}"`
  const pkgs = {
    [tgtName]: {
      [tgtVer]: {
        deps: {
          '@types/prop-types': '*',
          'csstype': '^3.0.2'
        }
      }
    },
    '@types/prop-types': { '15.7.3': {} },
    'csstype': { '3.0.5': {} }
  }
  return runNpmCmd(testNpm, 'download', [ '--dl-dir='+dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install',
    [ '--offline', '--offline-dir='+dlPath, spec ], { cwd: installPath }
  ))
  .then(() => checkInstalled(t1, pkgs, installPath))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
  .finally(() => {
    t1.end()
  })
})

// Case 6: package with a peer dep with deps
tap.test('6', t1 => {
  const tgtName = 'ajv-keywords'
  const tgtVer = '1.5.1'
  const spec = `${tgtName}@${tgtVer}`
  const peerName = 'ajv'
  const peerVer = '6.12.6'
  const peerRange = '>=4.10.0'
  const RE_resolvePeerFailureWarning1 =
    /\bnpm WARN Could not resolve dependency:/
  const RE_resolvePeerFailureWarning2 =
    new RegExp(`\\bnpm WARN peer ${peerName}@"${peerRange}"`)
  const RE_missingPeerError = new RegExp([
    '\\bnpm ERR! Download Tracker knows nothing about "',
    peerName, '@', peerRange, '"'
  ].join(''))
  const pkgs = {
    [tgtName]: {
      [tgtVer]: { peerDeps: { [peerName]: peerRange } }
    },
    [peerName]: {
      [peerVer]: {
        peer: true, deps: {
          'fast-deep-equal': '^3.1.1',
          'fast-json-stable-stringify': '^2.0.0',
          'json-schema-traverse': '^0.4.1',
          'uri-js': '^4.2.2'
        }
      }
    },
    'fast-deep-equal': { '3.1.3': { peer: true } },
    'fast-json-stable-stringify': { '2.1.0': { peer: true } },
    'json-schema-traverse': { '0.4.1': { peer: true } },
    'punycode': { '2.1.1': { peer: true } },
    'uri-js': { '4.4.0': { peer: true, deps: { 'punycode': '^2.1.0' } } }
  }

  t1.test('6-baseline', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const installPath = path.join(testBase, installDirName)

    // Theoretically, a package that has a peer dependency is useless without
    // the peer. However, npm allows such a package to be installed without the
    // peer simply by adding omit=peer to the command line.
    return runNpmCmd(
      testNpm, 'install',
      [ '--omit=peer', spec ], { cwd: installPath }
    )
    .then(() => checkProjectRootPostInstall(t2, installPath))
    .then(() => readdirAsync(path.join(installPath, 'node_modules')))
    .then(list => {
//console.log('Case 6-baseline node_modules contents:', list)
      t2.equal(list.length, 2, 'Nothing more or less than what is expected')
      t2.ok(list.includes(tgtName), `package ${tgtName} is installed`)
      // So what's the only other entry?
      t2.ok(list.includes('.package-lock.json'))

      return checkPackageLock(t2, installPath, pkgs, tgtName)
    })
    .finally(() => {
      t2.end()
    })
  })
  // TODO: a special section in the README about peerDependencies with/without
  // the use of --include=peer and --omit=peer
  // ( this might turn into a section about all kinds of non-regular dependencies!)

  // First: without include=peer, download succeeds, but install fails for lack
  // of the peer dep of the target package, because npm defaults to trying to
  // install peer deps, even if unrequested
  t1.test('6a', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const installPath = path.join(testBase, installDirName)

    return runNpmCmd(
      testNpm, 'download', [ '--dl-dir='+dlPath, spec ]
    )
    // Does *not* include peer deps by default
    .then(() => readdirAsync(dlPath))
    .then(list => {
//console.log('Case 6a download dir contents:', list)
      t2.equal(list.length, 3, 'Nothing more or less than what is expected')
      t2.ok(list.includes(`${tgtName}-${tgtVer}.tar.gz`), 'Target package tarball was downloaded')
      t2.ok(list.includes('dltracker.json'), 'dltracker.json file was created')
      t2.ok(list.includes('dl-temp'), 'temp dir for cache was created')

      return runNpmCmd(
        testNpm, 'install',
        [ '--offline', '--offline-dir='+dlPath, spec ], { cwd: installPath }
      )
      // Fails because npm install tries to include peer deps by default
      .catch(err => {
        t2.match(err.message, /^Command failed:/)
// TODO: find out where this warning is coming from, and what it means:
        t2.match(err.stderr, /^npm WARN ERESOLVE overriding peer dependency/)
        t2.match(err.stderr, RE_resolvePeerFailureWarning1)
        t2.match(err.stderr, RE_resolvePeerFailureWarning2)
        t2.match(err.stderr, RE_missingPeerError)
      })
    })
    .then(() => readdirAsync(installPath)).then(list => {
//console.log('Case 6a install dir contents:', list)
      t2.same(list, [ 'package.json' ], 'install destination has nothing new')
    })
    // Try again with --force, but it still won't work:
    .then(() => runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir='+dlPath, '--omit=peer', '--force', spec ],
      { cwd: installPath }
    ))
    .catch(err => {
//console.log('Case 6a error after install --force:', err)
      t2.match(err.message, /^Command failed:/)
// TODO: find out where this warning is coming from, and what it means:
      t2.match(err.stderr, /\bnpm WARN ERESOLVE overriding peer dependency/)
      t2.match(err.stderr, RE_resolvePeerFailureWarning1)
      t2.match(err.stderr, RE_resolvePeerFailureWarning2)
      t2.match(err.stderr, RE_missingPeerError)
    })
    .then(() => readdirAsync(installPath)).then(list => {
//console.log('Case 6a install dir contents after install --force:', list)
      t2.same(list, [ 'package.json' ], 'install destination has nothing new')
    })
    .finally(() => {
      t2.end()
    })
  })

  // Second: we start with a project in which the peer dep is already installed.
  // Download of the target package succeeds without include=peer; then we pass
  // --omit=peer and --force to install. Gives a warning, but succeeds.
  t1.test('6b', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const installPath = path.join(testBase, installDirName)

    return runNpmCmd(
      testNpm, 'install', [ `${peerName}@"${peerRange}"` ],
      { cwd: installPath }
    )
    .then(() => runNpmCmd(
      testNpm, 'download', [ '--dl-dir='+dlPath, spec ]
    ))
    // If there was no --force in the following, offline install would fail
    // with the error "ERESOLVE unable to resolve dependency tree":
    .then(() => runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir='+dlPath, '--omit=peer', '--force', spec ],
      { cwd: installPath }
    ))
    .then(() => checkInstalled(t2, pkgs, installPath))
    // 1. npm was unable to determine if there exists a better match (than the
    //   version already installed) for the peer spec identified by the target
    //   package, because the DownloadTracker knows nothing about it; and
    // 2. we used --force, which in this case tells npm not to try to resolve
    //   the relationships.
    // Hence the peer dependencies end up with no peer flag in the package-lock
    // entries. This is why we pass the omit: ['peer'] option in the following,
    // because otherwise checkPackageLock would expect the peer flags.
    .then(() => checkPackageLock(
      t2, installPath, pkgs, tgtName, { omit: ['peer'] }
    ))
/*
  TODO:
  This is a nagging problem. The npm documentation says nothing about omit=peer
  being overridden by anything but include=peer on the same command line; yet
  npm install is still insisting on trying to obtain the peer dependency, and
  causing an error when it can't. SO, two things to try:
  1. Do a straight npm install of the target package from the mock registry,
    and see what happens -- DONE
  2. Change the case where omit=peer is used, to be the one where the peer dep
    got downloaded with the target package, and see what happens.
  My theory is that the install with omit=peer would work fine where the dest
  already has the peer dep installed (could be wrong, if npm wants to check for
  a later version to satisfy the range spec); maybe it would even work fine if
  the registry record/downloaded tarball is available...
  OBSERVATIONS:
  1) Even if the peer dependency is already installed, offline installation of
    the package that has a peer dep, with --omit=peer, fails with an error
    indicating that npm is unable to resolve the dependency tree. Clearly npm
    wants some manifest info (e.g., from the registry).
  2) If the option --force is given with the above, installation succeeds with
    only a brief warning about "Recommended protections disabled."
*/
    .finally(() => {
      t2.end()
    })
  })

  // Third: with include=peer, download succeeds in fetching all the peer deps;
  // then install succeeds in installing everything.
  t1.test('6c', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const installPath = path.join(testBase, installDirName)

    return runNpmCmd(
      testNpm, 'download', [ '--dl-dir='+dlPath, '--include=peer', spec ]
    )
    .then(() => checkDownloads(t2, pkgs, dlPath))
    .then(() => runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir='+dlPath, spec ], { cwd: installPath }
    ))
    // All peer deps get installed, by default
    .then(() => checkInstalled(t2, pkgs, installPath))
    .then(() => checkPackageLock(t2, installPath, pkgs, tgtName))
    .finally(() => {
      t2.end()
    })
  })

  // 4th: with include=peer, download succeeds in fetching all the peer deps;
  // then we install with --omit=peer and expect only the target package.
  t1.test('6d', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const installPath = path.join(testBase, installDirName)

    return runNpmCmd(
      testNpm, 'download', [ '--dl-dir='+dlPath, '--include=peer', spec ]
    )
    .then(() => runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir='+dlPath, '--omit=peer', spec ],
      { cwd: installPath }
    ))
    .then(() => checkProjectRootPostInstall(t2, installPath))
    .then(() => readdirAsync(path.join(installPath, 'node_modules')))
    .then(list => {
//console.log('Case 6d node_modules contents:', list)
      t2.equal(list.length, 2, 'Nothing more or less than what is expected')
      t2.ok(list.includes(tgtName), `package ${tgtName} is installed`)
      // So what's the only other entry?
      t2.ok(list.includes('.package-lock.json'))
    })
    // The records for the peer dependencies in the package-lock have the
    // peer flag in this case.
    .then(() => checkPackageLock(t2, installPath, pkgs, tgtName))
    .finally(() => {
      t2.end()
    })
  })

  t1.end()
})

// Case 7: package with cycle(s) in its tree of regular deps
tap.test('7', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const tgtName = 'test-root-matches-metadep'
  const tgtVer = '1.0.0'
  const spec = `${tgtName}@${tgtVer}`
  const pkgs = {
    [tgtName]: {
      [tgtVer]: {
        deps: {
          'test-root-matches-metadep-x': '1.0.0',
          'test-root-matches-metadep-y': '1.0.0'
        }
      },
      '1.0.1': {
        parent: 'test-root-matches-metadep-y', deps: {
          'test-root-matches-metadep-x': '1.0.0',
          'test-root-matches-metadep-y': '1.0.0'
        }
      }
    },
    'test-root-matches-metadep-x': {
      '1.0.0': { deps: { 'test-root-matches-metadep': '1.0.0' } }
    },
    'test-root-matches-metadep-y': {
      '1.0.0': { deps: { 'test-root-matches-metadep': '1.0.1' } }
    }
  }

  return runNpmCmd(testNpm, 'download', [ '--dl-dir='+dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install', [ '--offline', '--offline-dir='+dlPath, spec ],
    { cwd: installPath }
  ))
  .then(() => checkInstalled(t1, pkgs, installPath))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
  .finally(() => {
    t1.end()
  })
})

// Case 8: package with bundled deps
tap.test('8', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const tgtName = '@isaacs/testing-bundledeps'
  const tgtVer = '1.0.0'
  const spec = `${tgtName}@${tgtVer}`
  const pkgs = {
    [tgtName]: {
      [tgtVer]: {
        deps: {
          '@isaacs/testing-bundledeps-a': '*',
          '@isaacs/testing-bundledeps-c': '*'
        },
        bundleDependencies: [
          '@isaacs/testing-bundledeps-a'
        ]
      }
    },
    '@isaacs/testing-bundledeps-b': {
      '1.0.0': {}
    },
    '@isaacs/testing-bundledeps-c': {
      '2.0.0': { deps: { '@isaacs/testing-bundledeps-b': '*' } }
    },
    '@isaacs/testing-bundledeps-a': {
      '1.0.0': {
        inBundle: true, parent: '@isaacs/testing-bundledeps',
        deps: { '@isaacs/testing-bundledeps-b': '*' }
      }
    }
  }

  /*
    NOTE about the commented-out lines below: KEEP them until the next
    registry package test case is written, because it will be useful to
    copy them in for development.
  */
  return runNpmCmd(testNpm, 'download', [ '--dl-dir='+dlPath, spec ])
  //.then(() => readdirAsync(dlPath)).then(list =>
    //console.log('Case 8 download dir contents:', list)
  //)
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install', [ '--offline', '--offline-dir='+dlPath, spec ],
    { cwd: installPath }
  ))
  //.then(() => readdirAsync(path.join(installPath, 'node_modules')))
  //.then(list => console.log('Case 8 post-install node_modules contents:', list))
  .then(() => checkInstalled(
    t1, pkgs, installPath//, { debug: 'Case 8 path-contents map:' }
  ))
  //.then(() => getJsonFileData(path.join(installPath, 'package-lock.json')))
  //.then(data =>
  //  console.log('Case 8 package-lock contents of packages:', data.packages)
  //)
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
  .catch(err => console.error('$$$$ WTF?', err))
  .finally(() => {
    t1.end()
  })
})

tap.test('git 1', async t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const host = 'localhost:' + gitHostPort
  const spec = `git://${host}/${repoName1}`

  return runNpmCmd(testNpm, 'download', [ '--dl-dir='+dlPath, spec ])
  .then(() => readdirAsync(dlPath))
  .then(list => {
//console.log('After download of git pkg, we have:', list)
    // TODO: these notes go to a journal entry that ends with the discovery that
    // pacote and cacache are discarding the last component of the path passed
    // for cache, and creating the cache in the parent directory instead!
    // But how did I fix this?
    // Interesting results in our download directory when we fetch a git repo
    // that has a prepare script:
    // * _cacache: probably a directory
    // * _update-notifier-last-checked
    // So we can't expect to find only the tarball and the dltracker.json!
    t1.equal(list.length, 3, 'Nothing more or less than expected')
    t1.ok(list.includes('dltracker.json'), 'dltracker.json file was created')
    t1.ok(list.includes('dl-temp'), 'temp dir for cache was created')

    const RE_REPO = new RegExp([
      '^', encodeURIComponent(`${host}/${repoName1}#`), '[0-9a-z]{40}\.tar\.gz$'
    ].join(''))
    t1.ok(
      list.find(el => RE_REPO.test(el)),
      'Target git repo was downloaded as a tarball'
    )

    return runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir='+dlPath, spec ], { cwd: installPath }
    )
  })
  .then(() => checkProjectRootPostInstall(t1, installPath))
  .then(() => readdirAsync(path.join(installPath, 'node_modules')))
  .then(list => {
//console.log('installation target node_modules contents:', list)
    const expected = [ '.package-lock.json', 'top-repo' ]
    t1.same(list, expected, 'Nothing more or less than expected in node_modules')
    return readdirAsync(path.join(installPath, 'node_modules', repoName1))
  }).then(list => {
//console.log('target package dir contents:', list)
    const expected = [ 'README.md', 'index.js', 'package.json' ]
    t1.same(
      list.sort(), expected.sort(),
      'Nothing more or less than expected in package installation'
    )
  })
  .then(() => getJsonFileData(path.join(installPath, 'package-lock.json')))
  .then(data => {
//console.log('Case git 1 package-lock contents of packages:', data.packages)
    const expected = {
      '': {
        name: installDirName, version: '1.0.0',
        dependencies: { [repoName1]: spec }
      },
      ['node_modules/' + repoName1]: {
        version: '1.0.0'
      }
    }
    t1.match(data.packages, expected)
  })
  .finally(() => {
    t1.end()
  })
})

tap.test('url 1', async t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const tgtName = 'remote1'
  const tgtVer = '1.0.0'
  const spec = `http://localhost:${remotePort}/skizziks/${tgtName}-${tgtVer}.tgz`
  const pkgs = {
    [tgtName]: {
      [tgtVer]: {
        rawSpec: spec,
        deps: {
          'acorn-jsx': '^3.0.0',
          'bcrypt-pbkdf': '*'
        }
      }
    },
    'acorn-jsx': { '3.0.1': { deps: { 'acorn': '^3.0.4' } } },
    'acorn': { '3.3.0': {} },
    'bcrypt-pbkdf': { '1.0.2': { deps: { 'tweetnacl': '^0.14.3' } } },
    'tweetnacl': { '0.14.5': {} }
  }

  return runNpmCmd(testNpm, 'download', [ '--dl-dir='+dlPath, spec ])
  //.then(() => readdirAsync(dlPath)).then(list =>
    //console.log('Case Remote download dir contents:', list)
  //)
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install', [ '--offline', '--offline-dir='+dlPath, spec ],
    { cwd: installPath }
  ))
  //.then(() => readdirAsync(path.join(installPath, 'node_modules')))
  //.then(list => console.log('Case Remote post-install node_modules contents:', list))
  .then(() => checkInstalled(
    t1, pkgs, installPath//, { debug: 'Case 8 path-contents map:' }
  ))
  //.then(() => getJsonFileData(path.join(installPath, 'package-lock.json')))
  //.then(data =>
    //console.log('Case Remote package-lock contents of packages:', data.packages)
  //)
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
  .catch(err => console.error('$$$$ WTF?', err))
  .finally(() => {
    t1.end()
  })
})

