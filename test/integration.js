const {
  chmod, copyFile, lstat, mkdir, readdir, readFile, rm,
  symlink, writeFile, unlink
} = require('fs/promises')
const path = require('path')
const { promisify } = require('util')
const execAsync = promisify(require('child_process').exec)

const cmdShim = require('cmd-shim')
const tap = require('tap')
const tar = require('tar')

const graft = require('./lib/graft')
const gitServer = require('./lib/git-server')
const remoteServer = require('./lib/remote-server')
const arbFixtures = './fixtures/arborist/fixtures'
const { registry } = require(arbFixtures + '/server.js')
const mockRegistryProxy = require('./lib/mock-server-proxy')

// Where the test npm will be installed
const staging = path.resolve(__dirname, 'staging')
const stagedNpmDir = path.join(
  staging, process.platform == 'win32' ? '' : 'lib', 'node_modules/npm'
)
const testNpm = path.join(
  staging, process.platform == 'win32' ? '' : 'bin', 'npm'
)
const execMode = 0o777 & (~process.umask())

const copyNpmToStaging = () => {
  const srcParent = path.resolve(__dirname, '../node_modules')
  const dest = path.dirname(stagedNpmDir)
  return new Promise((resolve, reject) => {
    let hadError = false
    tar.c({ cwd: srcParent }, [ 'npm' ])
    .pipe(tar.x({ cwd: dest }))
    .once('error', err => {
      hadError = true
      reject(err)
    })
    .once('close', () => {
      if (!hadError) resolve()
    })
  })
}

const makeNpmBinLinks = () => {
  const npmCliPath = path.join(stagedNpmDir, 'bin/npm-cli.js')
  if (process.platform === 'win32') {
    return cmdShim(npmCliPath, testNpm)
  }
  else {
    const linkHome = path.dirname(testNpm)
    const linkToPath = path.relative(linkHome, npmCliPath)
    const startDir = process.cwd()
    return mkdir(linkHome)
    .then(() => {
      process.chdir(linkHome)
      return symlink(linkToPath, 'npm')
    })
    .then(() => chmod(npmCliPath, execMode))
    .finally(() => process.chdir(startDir))
  }
}

// Copy all the npm-two-stage source files into the staged npm
// (overwriting original files where applicable)
function applyN2SFiles() {
  const src = path.resolve(__dirname, '../src')
  const dest = path.join(stagedNpmDir, 'lib')
  let npmLibList
  return readdir(dest)
  .then(list => {
    npmLibList = list
    return readdir(src).then(items => nextItem('', items, 0))
  })

  function nextItem(offset, list, i) {
    if (i >= list.length) return Promise.resolve()
    const item = list[i]
    const srcItemPath = path.join(src, offset, item)
    return lstat(srcItemPath).then(srcStats => {
      const target = path.join(dest, offset, item)
      let p
      if (srcStats.isDirectory()) {
        p = offset == '' && !npmLibList.includes(item) ?
          graft(srcItemPath, dest) :
          readdir(srcItemPath).then(entries =>
            mkdir(target)
            .catch(err => {
              if (err.code != 'EEXIST') throw err
            })
            .then(() => nextItem(path.join(offset, item), entries, 0))
          )
      }
      else if (srcStats.isFile())
        // We don't do COPYFILE_EXCL here because we don't do backups in this
        // sandboxed test situation, we simply overwrite
        p = copyFile(srcItemPath, target)
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

const runNpmCmd = async (npmBin, cmd, argList, opts, prepend) => {
  // NOTES
  // * For almost all calls, we need npm to be configured with
  //   globalPrefix=staging, registry=registry, ...
  // * If environment var PREFIX is set, npm load will set globalPrefix to that.
  // * In download.js, we set the cache to a custom location:
  //   'dl-temp/cache' in the dl-dir.
  if (!argList) argList = []
  // Defective behavior has been seen from @npmcli/config. We have adapted
  // download.js to handle some of that, so we need this flexibility in the
  // arrangement of the command line arguments in order to test error cases:
  if (prepend) argList.unshift('--registry', registry)
  else argList.push('--registry', registry)

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

const dlOverheadItems = [ 'dltracker.json' ]

const RE_RMV_PROTO = /^[a-z]+:\/\/(.+)$/
const RE_TARBALL_EXT = /\.(tar\.gz|tgz)$/

const checkDownloads = (t, pkgMap, dlPath) =>
  readdir(dlPath).then(list => {
    const expectedItems = [ 'dltracker.json' ]
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
    // It's no good using t1.same() on an array unless the sequence
    // of 'found' matches that of 'wanted'.
    t.same(
      list.sort(), expectedItems.sort(),
      'download dir contains all expected items'
    )
  })

const checkProjectRootPostInstall = (t, projectRoot) =>
  readdir(projectRoot).then(list => {
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
    return readdir(path.join(node_modules, dir))
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
  // TODO: Think about moving this and the other helper functions out to a
  // separate module, and then writing a test suite for it. It's complex enough.
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
      and expect readdir to give us the associated list
      (once .package-lock.json and .bin are disregarded)
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
  return readFile(filepath, { encoding: 'utf8' }).then(str => {
    // Strip BOM, if any
    if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1)
    return JSON.parse(str)
  })
}

const checkPackageLock = (t, installPath, pkgs, tgtName, opts) =>
  getJsonFileData(path.join(installPath, 'package-lock.json')).then(pkgLk => {
    // TODO?: get the integrity value from the previous run of npm install,
    // and store it in a convenient place in pkgs;
    // when we get here, add it to the object to compare
    opts = opts || {}
    if (!opts.omit) opts.omit = []
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
        if (data.peer && opts.omit.includes('peer')) continue
        let modPath = 'node_modules/' + name
        if (data.parent) modPath = `node_modules/${data.parent}/${modPath}`
        expected[modPath] = { version: v }
        // TODO?: this is where we'd apply 'integrity'
        if (data.deps)
          expected[modPath].dependencies = data.deps
        if (data.peerDeps)
          expected[modPath].peerDependencies = data.peerDeps
        if (data.peer)
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
      message: 'prepare script',
      getCommit: true
    },
    {
      filename: 'README.md',
      content: 'This is documentation.',
      message: 'added documentation',
      version: '1.0.0',
      getCommit: true
    },
    {
      filename: 'README.md',
      content: 'This is UPDATED documentation.',
      message: 'updated docs',
      getCommit: true
    }
  ]
}
const gitCommits = {}
const gitHostPort = 19418
const gitHostBaseName = 'gitBase'
const gitRepoId1 = `localhost:${gitHostPort}/${repoName1}`
const remoteBaseRelPath = 'fixtures/data'
const cfg = {
  git: {}, remote: {}
}

tap.before(() => {
  const rootPath = tap.testdir({
    [testCacheName]: {}
  })
  const testCache = path.resolve(rootPath, testCacheName)
  // NOTE: formerly had cfg.git.hostBase in the tap.testdir; but was getting
  // EBUSY error from rmdir on teardown, even though the tap doc for fixtures
  // says "The fixture directory cleanup will always happen after any
  //  user-scheduled t.teardown() functions, as of tap v14.11.0."
  // Funny, now that removal is done *during* teardown, the problem is gone.
  cfg.git.hostBase = path.resolve(staging, 'srv', gitHostBaseName)
  cfg.remote.base = path.resolve(__dirname, remoteBaseRelPath)

  return rm(staging, { recursive: true, force: true })
  .then(() => mkdir(path.dirname(stagedNpmDir), { recursive: true }))
  // We would like to avoid leaving any test traces in the user's filesystem
  // outside of the test directory:
  .then(() => mkdir(path.join(staging, 'etc')))
  .then(() => writeFile(
    path.join(staging, 'etc/npmrc'),
    `cache=${testCache}\nupdate-notifier=false\n`
  ))
  .then(() => mkdir(cfg.git.hostBase, { recursive: true }))
  .then(() => copyNpmToStaging())
  .then(() => makeNpmBinLinks())
  // The executable of the test installation is now at testNpm;
  // the target location for npm-two-stage is at stagedNpmDir.
  .then(() => {
    console.log('npm installation seems to have been successful...')
    return applyN2SFiles()
  })
  .then(() => mockRegistryProxy.start())
  .then(() => gitServer.start(gitHostPort, cfg.git.hostBase))
  .then(() => gitServer.createRepo(repoName1, repoCfg1, testNpm))
  .then(commits => gitCommits[repoName1] = commits)
  .then(() => remoteServer.start(cfg.remote.base))//, { debug: true }))
  .then(num => {
    cfg.remote.port = num
    cfg.remote.items = [
      { name: 'remote1', version: '1.0.0' },
      { name: 'remote2', version: '1.1.0' }
    ]
    for (const item of cfg.remote.items) {
      const file = `${item.name}-${item.version}.tgz`
      item.id = `localhost:${num}/skizziks/${file}`
    }
    cfg.pjPath = path.join(staging, 'tmp', 'dl-pj')
    return mkdir(cfg.pjPath, { recursive: true })
  })
})
tap.teardown(() => {
  return new Promise(resolve => mockRegistryProxy.stop(() => resolve()))
  .then(() => gitServer.stop())
  .then(() => remoteServer.stop())
  .then(() => rm(staging, { recursive: true, force: true }))
})

// Path component names we'll be using a lot
const dlDirName = 'tarballs'
const installDirName = 'install-tgt'

tap.test('quick help', t1 => {
  const targetDir = t1.testdir()
  return runNpmCmd(testNpm, 'download', [ '-h' ], { cwd: targetDir })
  .then(({stdout, stderr}) => {
    t1.match(
      stdout,
      /\bDownload package\(s\) and dependencies as tarballs\n/,
      'quick help output for download command as expected'
    )
    // The following test has been removed because there can be warnings
    // about unrelated things, and warnings go to stderr:
    //t1.equal(stderr, '', 'no error output from quick help')
  })
})

tap.test('dl no args', t1 => {
  const targetDir = t1.testdir()
  t1.rejects(
    runNpmCmd(testNpm, 'download', [], { cwd: targetDir }),
    /npm ERR! No packages named for download\./
  )
  t1.end()
})

// Case 1: request for non-existent package
// Proves that it takes more than an invalid package spec to break download
// ... up to the point when it receives a reply from pacote.
tap.test('1', t1 => {
  const targetDir = t1.testdir()
  // Package name chosen to ensure that it won't be found.
  // Note: npm-package-arg has no problem with a name like 'OMGZ!',
  // even though npm (publish) would reject it.
  t1.rejects(
    runNpmCmd(testNpm, 'download', ['OMGZ!'], { cwd: targetDir }),
    /npm ERR! 404 Not Found/
  )
  t1.end()
})

// Case 2: package with no regular deps, spec'd by range
tap.test('2', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  // The mock registry packument for acorn lists higher versions than the
  // tarballs it has available, so we must be careful with the spec we use.
  const pkgName = 'acorn'
  const vSpec = '<4.0.5'
  const pkgSpec = `"${pkgName}@${vSpec}"`
  const resolvedVer = '4.0.4'
  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, pkgSpec ])
  .then(() => readdir(dlPath))
  .then(list => {
    const expected = [
      'dltracker.json', `${pkgName}-${resolvedVer}.tar.gz`
    ]
    t1.same(
      list.sort(), expected.sort(),
      'all and no more than expected items at download location'
    )

    return runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir', dlPath, pkgSpec ],
      { cwd: installPath }
    )
  })
  .then(() => readdir(path.join(installPath, 'node_modules')))
  .then(list => {
    t1.ok(list.includes(pkgName))
  })
  .then(() => getJsonFileData(path.join(installPath, 'package-lock.json')))
  .then(data =>
    t1.match(data.packages, {
      '': {
        name: installDirName, version: '1.0.0',
        dependencies: { acorn: vSpec }
      },
      'node_modules/acorn': { version: resolvedVer }
    })
  )
})

// The --before option works as expected with the download command.
// It was designed to work the way it does with the install command;
// but it's inappropriate to use it with install --offline.
// Though it may do the right thing in some cases, this set of tests
// reveals a pitfall in that usage.
tap.test('before option', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  // We use a different dl path for the expected fail, because an empty file
  // will be created there as a result of the attempt, and we don't want the
  // clutter at our success path:
  const failDirName = 'bad-dl'
  const failPath = path.join(testBase, failDirName)
  const expected = [ 'dltracker.json', 'acorn-4.0.4.tar.gz' ]
  // The mock registry packument for acorn lists higher versions than the
  // tarballs it has available, so implicitly asking for 'latest' should
  // result in an error:
  return mkdir(failPath)
  .then(() => t1.rejects(
    runNpmCmd(testNpm, 'download', ['acorn'], { cwd: failPath }),
    /npm ERR! 404 Not Found/,
    'mock registry does not have the latest of target package'
  ))
  // Now we choose a date that gets us the latest one it has.
  .then(() => runNpmCmd(
    testNpm, 'download',
    [ 'acorn', '--before', '2017', '--dl-dir', dlPath ]
  ))
  .then(() => readdir(dlPath))
  .then(list => {
    t1.same(
      list.sort(), expected.sort(),
      '--before option works with download command'
    )
  })
  // Now we fetch the earlier available version.
  .then(() => runNpmCmd(
    testNpm, 'download',
    [ 'acorn', '--before', '2016-08', '--dl-dir', dlPath ]
  ))
  // Verify that we have both versions
  .then(() => readdir(dlPath))
  .then(list => {
    t1.same(list.sort(), expected.concat(['acorn-3.3.0.tar.gz']).sort())
  })
  // Now we try to get npm install to pick the earlier version in the
  // offline stage:
  .then(() => runNpmCmd(
    testNpm, 'install',
    [ '--offline', '--offline-dir', dlPath, 'acorn', '--before', '2016-08' ],
    { cwd: installPath }
  ))
  .then(() => getJsonFileData(path.join(installPath, 'package-lock.json')))
  .then(data =>
    t1.equal(
      data.packages['node_modules/acorn'].version, '4.0.4',
      'installed the latest version instead of the requested one'
    )
  )
  //.catch(err => console.log(err))
})

// Case 3: package with a flat set of regular deps
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
  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install',
    [ '--offline', '--offline-dir', dlPath, spec ], { cwd: installPath }
  ))
  .then(() => checkInstalled(t1, pkgs, installPath))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
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
  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install',
    [ '--offline', '--offline-dir', dlPath, spec ], { cwd: installPath }
  ))
  .then(() => checkInstalled(t1, pkgs, installPath))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
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
  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install',
    [ '--offline', '--offline-dir', dlPath, spec ], { cwd: installPath }
  ))
  .then(() => checkInstalled(t1, pkgs, installPath))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
})

// Case 6: package with a peer dep with deps
tap.test('6', t1 => {
  const tgtName = 'ajv-keywords'
  const tgtVer = '1.5.1'
  const spec = `${tgtName}@${tgtVer}`
  const peerName = 'ajv'
  const peerVer = '4.11.2'
  const peerRange = '>=4.10.0'
  // Dev note: without the following dateLimitOption, we would get v6 of the
  // peer dep, which has a dependency on a package (uri-js) that contains a
  // yarn.lock file that demands a transitive dependency version that the
  // mock registry does not have - so we would get a 404 error instead of
  // useful results.
  const dateLimitOption = '--before 2017-02'
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
          'co': '^4.6.0',
          'json-stable-stringify': '^1.0.1'
        }
      }
    },
    'co': { '4.6.0': { peer: true } },
    'json-stable-stringify': {
      '1.0.1': { peer: true, deps: { 'jsonify': '~0.0.0' } }
    },
    'jsonify': { '0.0.0': { peer: true } }
  }

  t1.test('6-baseline', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const installPath = path.join(testBase, installDirName)

    // Theoretically, a package that has a peer dependency is useless without
    // the peer. However, npm allows such a package to be installed without the
    // peer simply by adding omit=peer to the command line.
    return runNpmCmd(
      testNpm, 'install',
      [ '--omit=peer', dateLimitOption, spec ], { cwd: installPath }
    )
    .then(() => checkProjectRootPostInstall(t2, installPath))
    .then(() => readdir(path.join(installPath, 'node_modules')))
    .then(list => {
      t2.equal(list.length, 2, 'Nothing more or less than what is expected')
      t2.ok(list.includes(tgtName), `package ${tgtName} is installed`)
      // So what's the only other entry?
      t2.ok(list.includes('.package-lock.json'))

      return checkPackageLock(t2, installPath, pkgs, tgtName)
    })
 })

  // First: with omit=peer, download succeeds, but install fails for lack of
  // the peer dep of the target package, because npm default is to install
  // peer deps, even if unrequested
  t1.test('6a', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const installPath = path.join(testBase, installDirName)

    // Would include peer deps by default, so we must explicitly omit
    return runNpmCmd(
      testNpm, 'download',
      [ '--dl-dir', dlPath, '--omit=peer', dateLimitOption, spec ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.equal(list.length, 2, 'Nothing more or less than what is expected')
      t2.ok(list.includes(`${tgtName}-${tgtVer}.tar.gz`), 'Target package tarball was downloaded')
      t2.ok(list.includes('dltracker.json'), 'dltracker.json file was created')
      t2.notOk(list.includes('dl-temp'), 'temp dir for cache should be removed')

      return runNpmCmd(
        testNpm, 'install',
        [ '--offline', '--offline-dir', dlPath, spec ], { cwd: installPath }
      )
      .then(() => t2.fail('peer dep unavailable, install without --force should reject'))
      // Fails because npm install tries to include peer deps by default
      .catch(err => {
        t2.match(err.message, /^Command failed:/)
        t2.match(err.stderr, /\bnpm WARN ERESOLVE overriding peer dependency/)
        t2.match(err.stderr, RE_resolvePeerFailureWarning1)
        t2.match(err.stderr, RE_resolvePeerFailureWarning2)
        t2.match(err.stderr, RE_missingPeerError)
      })
    })
    .then(() => readdir(installPath)).then(list => {
      t2.same(list, [ 'package.json' ], 'install destination has nothing new')
    })
    // Try again with --force, but it still won't work:
    .then(() => runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir', dlPath, '--omit=peer', '--force', spec ],
      { cwd: installPath }
    ))
    .then(() => t2.fail('peer dep unavailable, install with --force should reject'))
    .catch(err => {
      t2.match(err.message, /^Command failed:/)
      t2.match(err.stderr, /\bnpm WARN ERESOLVE overriding peer dependency/)
      t2.match(err.stderr, RE_resolvePeerFailureWarning1)
      t2.match(err.stderr, RE_resolvePeerFailureWarning2)
      t2.match(err.stderr, RE_missingPeerError)
    })
    .then(() => readdir(installPath)).then(list => {
      t2.same(list, [ 'package.json' ], 'install destination has nothing new')
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
      testNpm, 'install', [
        dateLimitOption, `${peerName}@"${peerRange}"`
      ],
      { cwd: installPath }
    )
    .then(() => runNpmCmd(
      testNpm, 'download', [ '--dl-dir', dlPath, dateLimitOption, spec ]
    ))
    // If there was no --force in the following, offline install would fail
    // with the error "ERESOLVE unable to resolve dependency tree":
    .then(() => runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir', dlPath, '--omit=peer', '--force', spec ],
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
  })

  // Third: with include=peer, download succeeds in fetching all the peer deps;
  // then install succeeds in installing everything.
  t1.test('6c', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const installPath = path.join(testBase, installDirName)

    return runNpmCmd(
      testNpm, 'download', [
        '--dl-dir', dlPath, dateLimitOption, '--include=peer', spec
      ]
    )
    .then(() => checkDownloads(t2, pkgs, dlPath))
    .then(() => runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir', dlPath, spec ], { cwd: installPath }
    ))
    // All peer deps get installed, by default
    .then(() => checkInstalled(t2, pkgs, installPath))
    .then(() => checkPackageLock(t2, installPath, pkgs, tgtName))
  })

  // 4th: with include=peer, download succeeds in fetching all the peer deps;
  // then we install with --omit=peer and expect only the target package.
  t1.test('6d', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const installPath = path.join(testBase, installDirName)

    return runNpmCmd(
      testNpm, 'download', [
        '--dl-dir', dlPath, dateLimitOption, '--include=peer', spec
      ]
    )
    .then(() => runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir', dlPath, '--omit=peer', spec ],
      { cwd: installPath }
    ))
    .then(() => checkProjectRootPostInstall(t2, installPath))
    .then(() => readdir(path.join(installPath, 'node_modules')))
    .then(list => {
      t2.equal(list.length, 2, 'Nothing more or less than what is expected')
      t2.ok(list.includes(tgtName), `package ${tgtName} is installed`)
      // So what's the only other entry?
      t2.ok(list.includes('.package-lock.json'))
    })
    // The records for the peer dependencies in the package-lock have the
    // peer flag in this case.
    .then(() => checkPackageLock(t2, installPath, pkgs, tgtName))
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

  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install', [ '--offline', '--offline-dir', dlPath, spec ],
    { cwd: installPath }
  ))
  .then(() => checkInstalled(t1, pkgs, installPath))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
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

  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install', [ '--offline', '--offline-dir', dlPath, spec ],
    { cwd: installPath }
  ))
  .then(() => checkInstalled(
    t1, pkgs, installPath//, { debug: 'Case 8 path-contents map:' }
  ))
  .then(() => checkPackageLock(t1, installPath, pkgs, tgtName))
})

// git repo, version unspecified, gets HEAD of default branch
tap.test('git 1', async t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const spec = 'git://' + gitRepoId1
  const expectedHash = gitCommits[repoName1][3] // the last one for the target repo

  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => readdir(dlPath))
  .then(list => {
    t1.equal(list.length, 2, 'Nothing more or less than expected')
    t1.ok(list.includes('dltracker.json'), 'dltracker.json file was created')
    t1.notOk(list.includes('dl-temp'), 'temp dir for cache should be removed')

    const tarball = [
      encodeURIComponent(gitRepoId1 + '#'), expectedHash, '\.tar\.gz'
    ].join('')
    t1.ok(
      list.includes(tarball),
      'Target git repo was downloaded as a tarball'
    )

    return runNpmCmd(
      testNpm, 'install',
      [ '--offline', '--offline-dir', dlPath, spec ], { cwd: installPath }
    )
  })
  .then(() => checkProjectRootPostInstall(t1, installPath))
  .then(() => readdir(path.join(installPath, 'node_modules')))
  .then(list => {
    const expected = [ '.package-lock.json', 'top-repo' ]
    t1.same(list, expected, 'Nothing more or less than expected in node_modules')
    return readdir(path.join(installPath, 'node_modules', repoName1))
  }).then(list => {
    const expected = [ 'README.md', 'index.js', 'package.json' ]
    t1.same(
      list.sort(), expected.sort(),
      'Nothing more or less than expected in package installation'
    )
  })
  .then(() => getJsonFileData(path.join(installPath, 'package-lock.json')))
  .then(data => {
    const expected = {
      '': {
        name: installDirName, version: '1.0.0',
        dependencies: { [repoName1]: spec }
      },
      ['node_modules/' + repoName1]: {
        version: '1.0.0',
        resolved: `${spec}#${expectedHash}`
      }
    }
    t1.match(data.packages, expected)
  })
})

// git repo specified by tag
tap.test('git 2', async t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const spec = `git://${gitRepoId1}#v1.0.0`
  // Expect the commit that got tagged as side effect of `npm version`:
  const expectedHash = gitCommits[repoName1][2]

  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => readdir(dlPath))
  .then(list => {
    const tarball = [
      encodeURIComponent(gitRepoId1 + '#'), expectedHash, '\.tar\.gz'
    ].join('')
    t1.ok(
      list.includes(tarball),
      'Target git repo was downloaded as a tarball'
    )
  })
})

// git repo specified by semver expression
tap.test('git 3', async t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const spec = `git://${gitRepoId1}#semver:^1`
  // Expect the commit that got tagged as side effect of `npm version`:
  const expectedHash = gitCommits[repoName1][2]

  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => readdir(dlPath))
  .then(list => {
    const tarball = [
      encodeURIComponent(gitRepoId1 + '#'), expectedHash, '\.tar\.gz'
    ].join('')
    t1.ok(
      list.includes(tarball),
      'Target git repo was downloaded as a tarball'
    )
  })
})

// git repo specified by commit hash
tap.test('git 4', async t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const expectedHash = gitCommits[repoName1][1]
  const spec = `git://${gitRepoId1}#${expectedHash}`

  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => readdir(dlPath))
  .then(list => {
    const tarball = [
      encodeURIComponent(`${gitRepoId1}#`), expectedHash, '\.tar\.gz'
    ].join('')
    t1.ok(
      list.includes(tarball),
      'Target git repo was downloaded as a tarball'
    )
  })
})

tap.test('url 1', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const remoteItem = cfg.remote.items[0]
  const spec = 'http://' + remoteItem.id
  const pkgs = {
    [remoteItem.name]: {
      [remoteItem.version]: {
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

  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => checkDownloads(t1, pkgs, dlPath))
  .then(() => runNpmCmd(
    testNpm, 'install', [ '--offline', '--offline-dir', dlPath, spec ],
    { cwd: installPath }
  ))
  .then(() => checkInstalled(
    t1, pkgs, installPath//, { debug: 'Case 8 path-contents map:' }
  ))
  .then(() => checkPackageLock(t1, installPath, pkgs, remoteItem.name))
})

tap.test('package-json', t1 => {
  const remoteItem = cfg.remote.items[1]
  const spec = 'http://' + remoteItem.id
  const pjFilePath = path.join(cfg.pjPath, 'package.json')
  const pjContent = {
    name: 'do-not-care', version: '0.0.0',
    dependencies: {
      'acorn': '^3.0.4',
      'commander': '2_x',
      [repoName1]: `git://${gitRepoId1}#v1.0.0`,
      [remoteItem.name]: 'http://' + remoteItem.id
    }
  }
  const repoTarball2 = [
    encodeURIComponent(`${gitRepoId1}#`), gitCommits[repoName1][2], '\.tar\.gz'
  ].join('')
  const expected = [
    'dltracker.json',
    'acorn-3.3.0.tar.gz', 'commander-2.20.3.tar.gz',
    repoTarball2, encodeURIComponent(remoteItem.id)
  ]
  const startDir = process.cwd()

  t1.before(() => writeFile(pjFilePath, JSON.stringify(pjContent)))

  t1.teardown(() => unlink(pjFilePath))

  // package-json option with path
  t1.test('A', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    return runNpmCmd(
      testNpm, 'download', [ '--package-json='+cfg.pjPath ], { cwd: dlPath }
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains all expected items'
      )
    })
  })
  // pj option with path
  t1.test('B', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    return runNpmCmd(
      testNpm, 'download', [ '--pj='+cfg.pjPath ], { cwd: dlPath }
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains all expected items'
      )
    })
  })
  // package-json option at end of args, no path
  t1.test('C', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    process.chdir(cfg.pjPath)
    return t2.rejects(
      runNpmCmd(
        testNpm, 'download', [ '--dl-dir', dlPath, '--package-json' ], {}, true
      ),
      /\nnpm ERR! package-json option must be given a path/
    )
    .finally(() => process.chdir(startDir))
  })
  // package-json option, no path, but followed by another option (--registry)
  t1.test('D', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    process.chdir(cfg.pjPath)
    return t2.rejects(
      runNpmCmd(
        testNpm, 'download', [ '--dl-dir', dlPath, '--package-json' ]
      ),
      /\nnpm ERR! package-json option must be given a path/
    )
    .finally(() => process.chdir(startDir))
  })
  // pj option, no path
  t1.test('E', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    process.chdir(cfg.pjPath)
    return t2.rejects(
      runNpmCmd(
        testNpm, 'download', [ '--dl-dir', dlPath, '--pj' ], {}, true
      ),
      /\nnpm ERR! package-json option must be given a path/
    )
    .finally(() => process.chdir(startDir))
  })
  // pj option, no path, but followed by another option (--registry)
  t1.test('F', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    process.chdir(cfg.pjPath)
    return t2.rejects(
      runNpmCmd(
        testNpm, 'download', [ '--dl-dir', dlPath, '--pj' ],
      ),
      /\nnpm ERR! package-json option must be given a path/
    )
    .finally(() => process.chdir(startDir))
  })

  t1.test('J option', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '--dl-dir', dlPath, '-J' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains all expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })
  // A test where -J is followed by another argument can be found below in
  // 'dl multiple cmdline specs'

  t1.end()
})

tap.test('other options', t1 => {
  const pjFilePath = path.join(cfg.pjPath, 'package.json')
  const pjContent = {
    name: 'do-not-care', version: '0.0.0',
    dependencies: {
      'abbrev': '*', // No deps. Expect to get 1.1.1
      'acorn-jsx': '^3.0.0' // expect 3.0.1. Dep acorn@^3.0.4; expect 3.3.0
    },
    peerDependencies: {
      'balanced-match': 'latest', // No deps. Expect to get 1.0.0
      'bcrypt-pbkdf': '*' // expect 1.0.2. Dep tweetnacl@^0.14.3; expect 0.14.5
    },
    optionalDependencies: {
      'commander': '2_x', // No deps. Expect to get 2.20.3
      'combined-stream': '^1' // expect 1.0.8. Dep delayed-stream@~1.0.0; expect 1.0.0
    },
    devDependencies: {
      'diff': '^1', // No deps. Expect to get 1.4.0
      'dashdash': '^1' // expect 1.14.1. Dep assert-plus@^1.0.0; expect 1.0.0
    }
  }
  const regTGZs = [
    'abbrev-1.1.1.tar.gz', 'acorn-jsx-3.0.1.tar.gz', 'acorn-3.3.0.tar.gz'
  ]
  const peerTGZs = [
    'balanced-match-1.0.0.tar.gz', 'bcrypt-pbkdf-1.0.2.tar.gz',
    'tweetnacl-0.14.5.tar.gz'
  ]
  const optTGZs = [
    'commander-2.20.3.tar.gz', 'combined-stream-1.0.8.tar.gz',
    'delayed-stream-1.0.0.tar.gz'
  ]
  const devTGZs = [
    'diff-1.4.0.tar.gz', 'dashdash-1.14.1.tar.gz', 'assert-plus-1.0.0.tar.gz'
  ]
  const startDir = process.cwd()

  t1.before(() => writeFile(pjFilePath, JSON.stringify(pjContent)))

  t1.teardown(() => unlink(pjFilePath))

  // devDependencies are not downloaded by default.
  // Show that all dependencies can be fetched in one run:
  t1.test('dl include dev', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs, ...devTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '-J', '--dl-dir', dlPath, '--include=dev' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // optionalDependencies are downloaded by default, but show that using
  // --include=optional does not hurt
  t1.test('dl include optional', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '-J', '--dl-dir', dlPath, '--include=optional' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // peerDependencies are downloaded by default, but show that using
  // --include=peer does not hurt
  t1.test('dl include peer', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...optTGZs, ...peerTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '-J', '--dl-dir', dlPath, '--include=peer' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // devDependencies are not downloaded by default, but show that using
  // --omit=dev does not hurt
  t1.test('dl omit dev', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '-J', '--dl-dir', dlPath, '--omit=dev' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  t1.test('dl omit optional', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [ ...dlOverheadItems, ...regTGZs, ...peerTGZs ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '-J', '--dl-dir', dlPath, '--omit=optional' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  t1.test('dl omit peer', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [ ...dlOverheadItems, ...regTGZs, ...optTGZs ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '-J', '--dl-dir', dlPath, '--omit=peer' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // --include overrides --omit of the same dep kind
  t1.test('dl omit and include dev', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs, ...devTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [
        '-J', '--dl-dir', dlPath, '--include=dev', '--omit=dev'
      ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // --include overrides --omit of the same dep kind
  t1.test('dl omit and include peer', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...optTGZs, ...peerTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [
        '-J', '--dl-dir', dlPath, '--include=peer', '--omit=peer'
      ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // (deprecated) alias for --include=dev
  t1.test('dl also dev', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs, ...devTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '-J', '--dl-dir', dlPath, '--also=dev' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // (deprecated) alias for --omit=dev
  t1.test('dl only prod', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download', [ '-J', '--dl-dir', dlPath, '--only=prod' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // Like --include=dev vs --omit=dev, --also=dev should override --only=prod
  t1.test('dl also and only', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs, ...devTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download',
      [ '-J', '--dl-dir', dlPath, '--only=prod', '--also=dev' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // Like --include=dev, --also=dev should override --omit=dev
  t1.test('dl also and omit dev', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs, ...devTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download',
      [ '-J', '--dl-dir', dlPath, '--also=dev', '--omit=dev' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  // Just as vs --omit=dev, --include=dev should override --only=prod
  t1.test('dl only prod and include dev', t2 => {
    const testBase = makeProjectDirectory(t2, dlDirName, installDirName)
    const dlPath = path.join(testBase, dlDirName)
    const expected = [
      ...dlOverheadItems, ...regTGZs, ...peerTGZs, ...optTGZs, ...devTGZs
    ]

    process.chdir(cfg.pjPath)
    return runNpmCmd(
      testNpm, 'download',
      [ '-J', '--dl-dir', dlPath, '--only=prod', '--include=dev' ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      t2.same(
        list.sort(), expected.sort(),
        'download dir contains only expected items'
      )
    })
    .finally(() => process.chdir(startDir))
  })

  t1.end()
})

tap.test('dl multiple cmdline specs', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const testData = {
    'psl': { spec: '^1', version: '1.8.0' },
    'abbrev': { spec: '*', version: '1.1.1' },
    'diff': { spec: '^1', version: '1.4.0' }
  }
  const pjFilePath = path.join(cfg.pjPath, 'package.json')
  const pjContent = {
    name: 'do-not-care', version: '0.0.0',
    dependencies: { 'psl': testData['psl'].spec }
  }
  const specs = []
  const tarballs = []
  const dlOverheadItems = [ 'dltracker.json' ]
  const startDir = process.cwd()

  for (const name in testData) {
    const item = testData[name]
    // Don't double-request the package.json dep
    if (!(name in pjContent.dependencies))
      specs.push(`${name}@${item.spec}`)
    tarballs.push(`${name}-${item.version}.tar.gz`)
  }
  process.chdir(cfg.pjPath)
  return writeFile(pjFilePath, JSON.stringify(pjContent))
  .then(() => runNpmCmd(
    testNpm, 'download', [ '--dl-dir', dlPath, '-J' ].concat(specs)
  ))
  .then(() => readdir(dlPath))
  .then(list => {
    t1.same(
      list.sort(), dlOverheadItems.concat(tarballs).sort(),
      'download dir contains only expected items'
    )
  })
  .finally(() => {
    process.chdir(startDir)
    return unlink(pjFilePath)
  })
})

tap.test('install from pj', t1 => {
  const gitSpec = `git://${gitRepoId1}#v1.0.0`
  const remoteItem = cfg.remote.items[1]
  const urlSpec = `http://${remoteItem.id}`
  const testBase = t1.testdir({
    [dlDirName]: {},
    [installDirName]: {
      'package.json': JSON.stringify({
        name: installDirName, version: '1.0.0',
        dependencies: {
          'acorn': '^3.0.4',
          'commander': '2_x',
          [repoName1]: gitSpec,
          [remoteItem.name]: urlSpec
        }
      })
    }
  })
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const specList = [ '"acorn@^3.0.4"', 'commander@2_x', gitSpec, urlSpec ]

  return runNpmCmd(
    testNpm, 'download', [ '--dl-dir', dlPath ].concat(specList)
  )
  .then(() => runNpmCmd(
    testNpm, 'install',
    // No spec --> refer to the package.json in cwd
    [ '--offline', '--offline-dir', dlPath ],
    { cwd: installPath }
  ))
  .then(() => readdir(path.join(installPath, 'node_modules')))
  .then(list => {
    const expected = [
      '.bin', '.package-lock.json', 'acorn', 'commander',
      repoName1, remoteItem.name
    ]
    t1.same(list.sort(), expected.sort())
  })
  .then(() => getJsonFileData(path.join(installPath, 'package-lock.json')))
  .then(data => {
    const lockExpected = {
      '': {
        name: installDirName, version: '1.0.0',
        dependencies: {
          'acorn': '^3.0.4',
          'commander': '2_x',
          [repoName1]: gitSpec,
          [remoteItem.name]: urlSpec
        }
      },
      'node_modules/acorn': { version: '3.3.0' },
      'node_modules/commander': { version: '2.20.3' },
      ['node_modules/' + repoName1]: { version: '1.0.0' },
      ['node_modules/' + remoteItem.name]: { version: remoteItem.version }
    }
    t1.match(data.packages, lockExpected)
  })
  //.catch(err => console.log('install-from-pj case:', err))
})

tap.test('alias spec', t1 => {
  const testBase = makeProjectDirectory(t1, dlDirName, installDirName)
  const dlPath = path.join(testBase, dlDirName)
  const installPath = path.join(testBase, installDirName)
  const pkgName = 'acorn'
  const alias = pkgName + '3'
  const plainSpec = pkgName + '@3'
  const aliasSpec = `${alias}@npm:${plainSpec}`
  const expandedVer = '3.3.0'
  const saveSpec = `${pkgName}@^${expandedVer}`
  return runNpmCmd(
    testNpm, 'download', [ '--dl-dir', dlPath, aliasSpec ]
  )
  .then(() => runNpmCmd(
    testNpm, 'install', [ '--offline', '--offline-dir', dlPath, aliasSpec ],
    { cwd: installPath }
  ))
  .then(() => getJsonFileData(path.join(installPath, 'package.json')))
  .then(pkg => {
    t1.match(pkg.dependencies, { [alias]: 'npm:' + saveSpec })
  })
  .then(() => getJsonFileData(path.join(installPath, 'package-lock.json')))
  .then(data => {
    const lockExpected = {
      '': {
        name: installDirName, version: '1.0.0',
        dependencies: { [alias]: 'npm:' + saveSpec }
      },
      ['node_modules/' + alias]: {
        name: pkgName, version: expandedVer,
        resolved: `https://registry.npmjs.org/${pkgName}/-/${pkgName}-${expandedVer}.tgz`
      }
    }
    t1.match(data.packages, lockExpected)
  })
})

tap.test('lockfile-dir option', t1 => {
  // A fixtures directory that has all 3 kinds of lockfile
  const srcDir = path.join(__dirname, 'fixtures/data/lockfiles')
  const lockfileDir = path.join(staging, 'tmp/lockfiles')
  const tbs = {
    shrinkwrap: {
      reg: [
        "braces-3.0.2.tar.gz",
        "fill-range-7.0.1.tar.gz",
        "is-number-7.0.0.tar.gz",
        "to-regex-range-5.0.1.tar.gz"
      ],
      dev: [
        "anymatch-3.1.1.tar.gz",
        "normalize-path-3.0.0.tar.gz",
        "picomatch-2.2.2.tar.gz",
      ]
    },
    pkgLock: {
      reg: [
        "ansicolors-0.3.2.tar.gz",
        "cardinal-2.1.1.tar.gz",
        "esprima-4.0.1.tar.gz",
        "redeyed-2.1.1.tar.gz"
      ],
      dev: [
        "anymatch-3.1.1.tar.gz",
        "normalize-path-3.0.0.tar.gz",
        "picomatch-2.2.2.tar.gz"
      ]
    },
    yarnLock: {
      reg: [
        "anymatch-3.1.1.tar.gz",
        "normalize-path-3.0.0.tar.gz",
        "picomatch-2.2.2.tar.gz"
      ],
      dev: [
        "braces-3.0.2.tar.gz",
        "fill-range-7.0.1.tar.gz",
        "is-number-7.0.0.tar.gz",
        "to-regex-range-5.0.1.tar.gz"
      ]
    }
  }

  t1.before(() => graft(srcDir, path.join(staging, 'tmp')))

  t1.test('npm-shrinkwrap', t2 => {
    const dlPath = t2.testdir()
    return runNpmCmd(
      testNpm, 'download',
      [ '--lockfile-dir', lockfileDir, '--dl-dir', dlPath ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      const tarballs = tbs.shrinkwrap.reg
      t2.same(
        list.sort(), dlOverheadItems.concat(tarballs).sort(),
        'download dir contains only expected items, src: npm-shrinkwrap'
      )
    })
  })

  t1.test('npm-shrinkwrap include dev', t2 => {
    const dlPath = t2.testdir()
    return runNpmCmd(
      testNpm, 'download',
      [ '--lockfile-dir', lockfileDir, '--include=dev', '--dl-dir', dlPath ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      const tarballs = tbs.shrinkwrap.reg.concat(tbs.shrinkwrap.dev)
      t2.same(
        list.sort(), dlOverheadItems.concat(tarballs).sort(),
        'download dir contains only expected items, src: npm-shrinkwrap'
      )
    })
  })

  t1.test('package-lock', t2 => {
    const dlPath = t2.testdir()
    return unlink(path.join(lockfileDir, 'npm-shrinkwrap.json'))
    .then(() => runNpmCmd(
      testNpm, 'download',
      [ '--lockfile-dir', lockfileDir, '--dl-dir', dlPath ]
    ))
    .then(() => readdir(dlPath))
    .then(list => {
      const tarballs = tbs.pkgLock.reg
      t2.same(
        list.sort(), dlOverheadItems.concat(tarballs).sort(),
        'download dir contains only expected items, src: package-lock'
      )
    })
  })

  t1.test('package-lock include dev', t2 => {
    const dlPath = t2.testdir()
    return runNpmCmd(
      testNpm, 'download',
      [ '--lockfile-dir', lockfileDir, '--include=dev', '--dl-dir', dlPath ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      const tarballs = tbs.pkgLock.reg.concat(tbs.pkgLock.dev)
      t2.same(
        list.sort(), dlOverheadItems.concat(tarballs).sort(),
        'download dir contains only expected items, src: package-lock'
      )
    })
  })

  t1.test('yarnlock', t2 => {
    const dlPath = t2.testdir()
    return unlink(path.join(lockfileDir, 'package-lock.json'))
    .then(() => runNpmCmd(
      testNpm, 'download',
      [ '--lockfile-dir', lockfileDir, '--dl-dir', dlPath ]
    ))
    .then(() => readdir(dlPath))
    .then(list => {
      const tarballs = tbs.yarnLock.reg
      t2.same(
        list.sort(), dlOverheadItems.concat(tarballs).sort(),
        'download dir contains only expected items, src: yarn.lock'
      )
    })
  })

  t1.test('yarnlock include dev', t2 => {
    const dlPath = t2.testdir()
    return runNpmCmd(
      testNpm, 'download',
      [ '--lockfile-dir', lockfileDir, '--include=dev', '--dl-dir', dlPath ]
    )
    .then(() => readdir(dlPath))
    .then(list => {
      const tarballs = tbs.yarnLock.reg.concat(tbs.yarnLock.dev)
      t2.same(
        list.sort(), dlOverheadItems.concat(tarballs).sort(),
        'download dir contains only expected items, src: yarn.lock'
      )
    })
  })

  t1.test('yarnlock but no package.json', t2 => {
    const dlPath = t2.testdir()
    return unlink(path.join(lockfileDir, 'package.json'))
    .then(() =>
      runNpmCmd(
        testNpm, 'download',
        [ '--lockfile-dir', lockfileDir, '--dl-dir', dlPath ]
      )
      .then(({ stdout, stderr }) => {
        t2.match(stderr, new RegExp(
          [
            //'',
            'Failed to read package\.json at given lockfile-dir',
            'Error code: ENOENT',
            'A package\.json is required to aid in processing a yarn\.lock',
            '.+', 'No usable lockfile at '
          ].join('\nnpm WARN download ')
        ))
      })
    )
  })

  t1.test('No lockfiles at given location', t2 => {
    const dlPath = t2.testdir()
    return unlink(path.join(lockfileDir, 'yarn.lock'))
    .then(() =>
      runNpmCmd(
        testNpm, 'download',
        [ '--lockfile-dir', lockfileDir, '--dl-dir', dlPath ]
      )
      .then(({ stdout, stderr }) => {
        t2.match(stderr, /\nnpm WARN download No usable lockfile at /)
      })
    )
  })

  t1.end()
})

tap.test('top level item has a shrinkwrap', t1 => {
  const dlPath = t1.testdir()
  const remoteTarball = 'shrinkwrap-v1-test-0.0.1.tgz'
  const pkgId = `localhost:${cfg.remote.port}/skizziks/${remoteTarball}`
  const spec = 'http://' + pkgId
  const regDepFiles = [
    encodeURIComponent(pkgId),
    'ansicolors-0.3.2.tar.gz',
    'cardinal-2.1.1.tar.gz',
    'esprima-2.2.0.tar.gz',
    'esprima-4.0.1.tar.gz',
    'redeyed-2.1.1.tar.gz'
  ]

  return runNpmCmd(testNpm, 'download', [ '--dl-dir', dlPath, spec ])
  .then(() => readdir(dlPath))
  .then(list => {
    t1.same(
      list.sort(), dlOverheadItems.concat(regDepFiles).sort(),
      'download dir contains only expected items, src: package-lock'
    )
  })
})

tap.test('dependency has a yarn.lock', t1 => {
  const remoteTarball = 'yarnlock-peer-deps-0.0.1.tgz'
  const pkgId = `localhost:${cfg.remote.port}/skizziks/${remoteTarball}`
  const urlSpec = 'http://' + pkgId
  const pjDirName = 'pjDir'
  const testBase = t1.testdir({
    [dlDirName]: {},
    [pjDirName]: {
      'package.json': JSON.stringify({
        name: pjDirName, version: '1.0.0',
        dependencies: {
          'yarnlock-peer-deps': urlSpec
        }
      })
    }
  })
  const dlPath = path.join(testBase, dlDirName)
  const pjPath = path.join(testBase, pjDirName)
  const regDepFiles = [
    encodeURIComponent(pkgId),
    'ansi-regex-5.0.0.tar.gz',
    'cli-table3-0.6.1.tar.gz',
    'colors-1.4.0.tar.gz',
    'emoji-regex-8.0.0.tar.gz',
    'is-fullwidth-code-point-3.0.0.tar.gz',
    'string-width-4.2.0.tar.gz',
    'strip-ansi-6.0.0.tar.gz'
  ]

  return runNpmCmd(
    testNpm, 'download', [ '--pj', pjPath, '--dl-dir', dlPath ]
  )
  .then(() => readdir(dlPath))
  .then(list => {
    t1.same(
      list.sort(), dlOverheadItems.concat(regDepFiles).sort(),
      'download dir contains only expected items, src: yarn.lock'
    )
  })
})
