const path = require('path')
const { promisify } = require('util')

const rimrafAsync = promisify(require('rimraf'))
const npa = require('npm-package-arg')
const tap = require('tap')

const mockCommitHash = require('./lib/mock-commit-hash')
const loadJsonFile = require('./lib/load-json-file')

const makeAssets = require('./lib/make-assets')

const testConfigs = [
  {
    spec: 'bitbucket:someuser/someproject',
    revsDoc: {
      versions: {
        '1.2.3': {
          sha: mockCommitHash(),
          ref: 'v1.2.3',
          type: 'tag'
        },
        '4.5.6': {
          sha: mockCommitHash(),
          ref: 'v4.5.6',
          type: 'tag'
        }
      },
      'dist-tags': {},
      refs: {
        master: {
          sha: mockCommitHash(),
          ref: 'master',
          type: 'branch'
        }
      }
    },
    manifest: {
      _resolved: 'git+ssh://git@bitbucket.org/someuser/someproject.git#REPLACE',
      _allRefs: [ 'master' ]
      // fields _sha and _from get added by the loop below
    },
    pkgJson: {
      name: 'someproject',
      version: '5.0.0',
      author: 'Some User'
    }
  },
  {
/*
  The following spec leads to manifest --> [_clone] calling
    [_cloneRepo](npaSpec.fetchSpec, '8675309', tmp) followed by
    .then(sha => {
      this.resolvedSha = sha
      if (!this.resolved)
        this[_addGitSha](sha)
  which evaluates to this[_setResolvedWithSha](addGitSha(this.spec, sha))
  where the argument to this[_setResolvedWithSha] in this case becomes
    spec.rawSpec.replace(/#.*$/, '') + `#${sha}`
  and then the overall result is setting this.resolved to that argument value.
*/
    spec: 'git://gittar.org/someuser/someproject#8675309',
    revsDoc: {
      versions: {},
      'dist-tags': {},
      refs: {
        master: {
          sha: mockCommitHash(),
          ref: 'master',
          type: 'branch'
        },
        '8675309': {
          sha: mockCommitHash(),
          ref: '8675309',
          type: 'tag'
        }
      }
    },
    manifest: {
      _resolved: 'git://gittar.org/someuser/someproject#REPLACE',
      _allRefs: [ '8675309' ]
      // fields _sha and _from get added by the loop below
    },
    pkgJson: {
      name: 'someproject',
      version: '1.1.1',
      author: 'Some User'
    }
  }
]

for (let i = 0; i < testConfigs.length; ++i) {
  const hashes = {}
  const revs = testConfigs[i].revsDoc
  const manifest = testConfigs[i].manifest
  const ref = manifest._allRefs[0]
  manifest._resolved = manifest._resolved.replace(/REPLACE$/, revs.refs[ref].sha)
  manifest._sha = revs.refs[ref].sha
  manifest._from = testConfigs[i].spec

  for (let v in revs.versions) {
    const record = Object.assign({}, revs.versions[v])
    revs.refs[record.ref] = record
  }
  for (let ref in revs.refs) {
    const sha = revs.refs[ref].sha
    if (!hashes[sha]) hashes[sha] = []
    hashes[sha].push(ref)
  }
  revs.shas = hashes
}

function manifestMatcher(pjSrc, annotSrc) {
  const pkgJson = pjSrc.pkgJson
  const annotations = annotSrc.manifest
  return { ...pkgJson, ...annotations, _integrity: /.+/ }
}

const stdOpts = { multipleRefs: true }
let AltGitFetcher
let mockCacache
let mockDirFetcher
let mockPacoteNpm
let mockReadPkgJson
let mockNpmCliGit
let mockLog
let n2sAssets

tap.before(() =>
  makeAssets('tempAssets2', 'download/alt-git.js')
  .then(assets => {
    n2sAssets = assets
    AltGitFetcher = require(assets.libDownload + '/alt-git')
    mockCacache = require(assets.nodeModules + '/cacache')
    mockDirFetcher = require(assets.nodeModules + '/pacote/lib/dir')
    mockPacoteNpm = require(assets.nodeModules + '/pacote/lib/util/npm')
    mockReadPkgJson = require(assets.nodeModules + '/read-package-json-fast')
    mockNpmCliGit = require(assets.nodeModules + '/@npmcli/git')
    mockLog = require(assets.nodeModules + '/npmlog')

    stdOpts.log = mockLog
  })
)
tap.teardown(() => rimrafAsync(n2sAssets.fs('rootName')))

tap.test('shortcut spec without committish', t => {
  const npaSpec = npa(testConfigs[0].spec)
  mockReadPkgJson.setTestConfig({
    [testConfigs[0].spec]: testConfigs[0].manifest
  })
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.https()]: testConfigs[0]
  })
  mockLog.purge() // In case we move tests around
  const gitFetcher = new AltGitFetcher(testConfigs[0].spec, stdOpts)
  gitFetcher.manifest().then(mani => {
    const expectedMani = manifestMatcher(testConfigs[0], testConfigs[0])
    t.match(mani, expectedMani, 'yields manifest with expected fields')
    t.same(mockLog.getList(), [])
    t.end()
  })
})
tap.test('shortcut spec with commit hash', t => {
  const sha = testConfigs[0].revsDoc.refs.master.sha
  const fullSpec = testConfigs[0].spec + '#' + sha
  const npaSpec = npa(fullSpec)
  mockReadPkgJson.setTestConfig({
    [fullSpec]: testConfigs[0].manifest
  })
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.sshurl()]: testConfigs[0]
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(fullSpec, stdOpts)
  gitFetcher.manifest().then(mani => {
    const expectedMani = manifestMatcher(testConfigs[0], testConfigs[0])
    t.match(mani, expectedMani, 'yields manifest with expected fields')
    t.match(mockLog.getList(), [])
    gitFetcher.manifest().then(mani2 => {
      t.equal(mani2, mani)
      t.same(mockLog.getList(), [])
      t.end()
    })
  })
})
tap.test('shortcut spec with commit hash, but no multipleRefs option', t => {
  const sha = testConfigs[0].revsDoc.refs.master.sha
  const fullSpec = testConfigs[0].spec + '#' + sha
  const npaSpec = npa(fullSpec)
  mockReadPkgJson.setTestConfig({
    [fullSpec]: testConfigs[0].manifest
  })
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.sshurl()]: testConfigs[0]
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    fullSpec, { log: mockLog }
  )
  gitFetcher.manifest().then(mani => {
    t.not('_allRefs' in mani, true,
      '_allRefs property does not get added if not requested')
    t.same(mockLog.getList(), [])
    t.end()
  })
})
tap.test('spec leads to no data from git.revs', t => {
  const testData = Object.assign({}, testConfigs[0])
  testData.revsDoc = null
  testData.manifest = Object.assign({}, testData.manifest)
  // Note: There is a _allRefs property in the result only because
  // 'multipleRefs' is included in stdOpts passed to AltGitFetcher below
  testData.manifest._allRefs = undefined
  const npaSpec = npa(testData.spec)
  mockReadPkgJson.setTestConfig({
    [testData.spec]: testData.manifest
  })
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.https()]: testData
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    testData.spec, stdOpts
  )
  gitFetcher.manifest().then(mani => {
    const expectedMani = manifestMatcher(testData, testData)
    t.match(mani, expectedMani, 'yields manifest with expected fields')
    t.same(mockLog.getList(), [])
    t.end()
  })
})
tap.test('spec leads to data with no refs from git.revs', t => {
  const testData = Object.assign({}, testConfigs[0])
  testData.manifest = Object.assign({}, testData.manifest)
  testData.manifest._allRefs = []
  testData.revsDoc = Object.assign({}, testData.revsDoc)
  const hashes = testData.revsDoc.shas = Object.assign({}, testData.revsDoc.shas)
  hashes[testData.manifest._sha] = null
  const npaSpec = npa(testData.spec)
  mockReadPkgJson.setTestConfig({
    [testData.spec]: testData.manifest
  })
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.https()]: testData
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    testData.spec, { ...stdOpts, speak: true }
  )
  gitFetcher.manifest().then(mani => {
    const expectedMani = manifestMatcher(testData, testData)
    t.match(mani, expectedMani, 'yields manifest with expected fields')
    t.same(mockLog.getList(), [])
    t.end()
  })
})
tap.test('spec at arbitrary host with committish that is not a SHA hash', t => {
  const npaSpec = npa(testConfigs[1].spec)
  mockReadPkgJson.setTestConfig({
    [testConfigs[1].spec]: testConfigs[1].manifest
  })
  mockNpmCliGit.setTestConfig({
    [npaSpec.fetchSpec]: testConfigs[1]
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    testConfigs[1].spec, stdOpts
  )
  gitFetcher.manifest().then(mani => {
    const expectedMani = manifestMatcher(testConfigs[1], testConfigs[1])
    t.match(mani, expectedMani, 'yields manifest with expected fields')
    t.same(mockLog.getList(), [])
    t.end()
  })
})
tap.test('spec at arbitrary host with SHA hash committish', t => {
  const manifest = Object.assign({}, testConfigs[1].manifest)
  manifest._from = manifest._resolved
  const testData = Object.assign({}, testConfigs[1])
  testData.spec = manifest._from
  testData.manifest = manifest
  mockReadPkgJson.setTestConfig({
    [manifest._from]: manifest
  })
  mockNpmCliGit.setTestConfig({
    [npa(manifest._from).fetchSpec]: testData
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    testData.spec, stdOpts
  )
  gitFetcher.manifest().then(mani => {
    const expectedMani = manifestMatcher(testData, testData)
    t.match(mani, expectedMani, 'yields manifest with expected fields')
    t.same(mockLog.getList(), [])
    t.end()
  })
})
tap.test('spec leads to package with a prepare script', t => {
  const sha = testConfigs[0].revsDoc.refs.master.sha
  const fullSpec = testConfigs[0].spec + '#' + sha
  const npaSpec = npa(fullSpec)
  mockReadPkgJson.setTestConfig({
    [fullSpec]: testConfigs[0].manifest
  })
  const testData = Object.assign({}, testConfigs[0])
  testData.pkgJson = Object.assign({}, testData.pkgJson)
  testData.pkgJson.scripts = {
    prepare: 'echo WOOHOO'
  }
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.sshurl()]: testData
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    fullSpec, { ...stdOpts, spec: fullSpec }
  )
  // Check that there's no residual value saved in mock pacote/lib/util/npm:
  t.equal(mockPacoteNpm.lastTarget(), undefined)
  gitFetcher.manifest().then(mani => {
    t.same(mockLog.getList(), [])
    const expectedMani = manifestMatcher(testData, testData)
    t.match(mani, expectedMani, 'yields manifest with expected fields')
    // Verify that mock pacote/lib/util/npm got called with a path for a
    // mock git clone:
    const RE_CLONEPATH = process.platform !== 'win32' ?
      new RegExp('^' + n2sAssets.fs('npmTmp')) :
      new RegExp('^' + n2sAssets.fs('npmTmp').replaceAll('\\', '\\\\'))

    t.match(mockPacoteNpm.lastTarget(), RE_CLONEPATH)
    // Verify that the previous call cleared the saved path:
    t.equal(mockPacoteNpm.lastTarget(), undefined)
    // Simulate whatever it is that's supposed to put the current package
    // on the list in the special pacote environment variable:
    process.env._PACOTE_NO_PREPARE_ = gitFetcher.resolved
    const dupGitFetcher = new AltGitFetcher(
      fullSpec, { ...stdOpts, spec: fullSpec }
    )
    dupGitFetcher.manifest().then(mani2 => {
      t.match(mockLog.getList(), [{
        level: 'info', prefix: 'prepare',
        message: /^skip prepare, already seen/
      }])
      // Verify that mock pacote/lib/util/npm did *not* get called this time:
      t.equal(mockPacoteNpm.lastTarget(), undefined)
      // The manifest given back should be identical to the previous, but
      // there is no PREPARE side effect this time, because the git url
      // got put on the noPrepare list.
      t.same(mani2, mani)
      t.end()
    })
  })
})
tap.test('spec leads to repo with a valid shrinkwrap file', t => {
  const sha = testConfigs[0].revsDoc.refs.master.sha
  const fullSpec = testConfigs[0].spec + '#' + sha
  const npaSpec = npa(fullSpec)
  mockReadPkgJson.setTestConfig({
    [fullSpec]: testConfigs[0].manifest
  })
  const data = Object.assign({}, testConfigs[0])
  data.pkgJson = Object.assign({}, data.pkgJson)
  data.shrinkwrapPath = path.join(__dirname, 'fixtures/data/valid-shrinkwrap.json')
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.sshurl()]: data
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    fullSpec, stdOpts
  )
  
  gitFetcher.manifest().then(mani => {
    t.same(mockLog.getList(), [])
    return loadJsonFile(data.shrinkwrapPath)
    .then(shrWrapData =>  {
      t.same(mani._shrinkwrap, shrWrapData)
    // This time, say that we don't want the shrinkwrap (coverage)
      const dupGitFetcher = new AltGitFetcher(
        fullSpec, Object.assign({ noShrinkwrap: true }, stdOpts)
      )
      dupGitFetcher.manifest().then(mani2 => {
        t.not('_shrinkwrap' in mani2, true,
          'manifest does not contain shrinkwrap data if omission is requested'
        )
        t.same(mockLog.getList(), [])
        t.end()
      })
    })
  })
})
tap.test('spec leads to repo with an invalid shrinkwrap file', t => {
  const sha = testConfigs[0].revsDoc.refs.master.sha
  const fullSpec = testConfigs[0].spec + '#' + sha
  const npaSpec = npa(fullSpec)
  mockReadPkgJson.setTestConfig({
    [fullSpec]: testConfigs[0].manifest
  })
  const data = Object.assign({}, testConfigs[0])
  data.pkgJson = Object.assign({}, data.pkgJson)
  data.badShrinkwrap = true
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.sshurl()]: data
  })
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    fullSpec, stdOpts
  )
  gitFetcher.manifest().then(mani => {
    t.not('_shrinkwrap' in mani, true,
      'manifest does not contain shrinkwrap data if shrinkwrap file is invalid'
    )
    t.match(mockLog.getList(), [{
      level: 'warn', prefix: 'AltGitFetcher.manifest',
      message: /^failed to parse shrinkwrap file/
    }])
    t.end()
  })
})
tap.test('stream from cloned repo has an error', t => {
  const npaSpec = npa(testConfigs[0].spec)
  mockReadPkgJson.setTestConfig({
    [testConfigs[0].spec]: testConfigs[0].manifest
  })
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.https()]: testConfigs[0]
  })
  mockDirFetcher.setErrorState('_tarballFromResolved', true)
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    testConfigs[0].spec, stdOpts
  )
  t.rejects(gitFetcher.manifest())
  .then(() => {
    mockDirFetcher.setErrorState('_tarballFromResolved', false)
    t.same(mockLog.getList(), [])
    t.end()
  })
})
tap.test('stream to cache has an error', t => {
  const testData = testConfigs[0]
  const npaSpec = npa(testData.spec)
  mockReadPkgJson.setTestConfig({
    [testData.spec]: testData.manifest
  })
  mockNpmCliGit.setTestConfig({
    [npaSpec.hosted.https()]: testData
  })
  mockCacache.setErrorState('putStream', true)
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    testData.spec, stdOpts//, noShrinkwrap }
  )
  gitFetcher.manifest().then(mani => {
    mockCacache.setErrorState('putStream', false)
    const expectedMani = manifestMatcher(testData, testData)
    t.match(mani, expectedMani, 'yields manifest with expected fields')
    t.match(mockLog.getList(), [{
      level: 'warn', prefix: 'AltGitFetcher[_istream]',
      message: /^cache write error:/
    }])
    t.end()
  })
})
tap.test('clone has a git pathspec error', t => {
  const testData = testConfigs[0]
  mockReadPkgJson.setTestConfig({
    [testData.spec]: testData.manifest
  })
  let errClass = mockNpmCliGit.errors.GitPathspecError
  mockNpmCliGit.setErrorState('clone', true, errClass)
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(
    testData.spec, stdOpts
  )
  gitFetcher.manifest().then(() => {
    throw new Error('Should have rejected')
  })
  .catch(err => {
    mockNpmCliGit.setErrorState('clone', false)
    t.same(mockLog.getList(), [])
    // Sadly, node-tap is not smart enough to do this in t.rejects():
    t.type(err, mockNpmCliGit.errors.GitPathspecError,
      'should get GitPathspecError')
    t.end()
  })
})
tap.test('clone has an error about https auth', t => {
  const testSpec = 'git+https://dummyAuthValue@bitbucket.org/someuser/someproject'
  mockReadPkgJson.setTestConfig({
    testSpec: testConfigs[0].manifest
  })
  let errClass = mockNpmCliGit.errors.GitConnectionError
  mockNpmCliGit.setErrorState('clone', true, errClass)
  mockLog.purge()
  const gitFetcher = new AltGitFetcher(testSpec, stdOpts)
  gitFetcher.manifest().then(() => {
    throw new Error('Should have rejected')
  })
  .catch(err => {
    mockNpmCliGit.setErrorState('clone', false)
    t.type(err, mockNpmCliGit.errors.GitConnectionError,
     'should get GitConnectionError')
    t.same(mockLog.getList(), [])
    t.end()
  })
})
// The last two tests are of features, copied from GitFetcher, that are
// never used by npm-two-stage code.
tap.test('static repoUrl()', t => {
  // repoUrl() is only usable with repos on well-known hosts -
  // where npa(spec) result has a 'hosted' property, which is the
  // argument to pass
  const h = npa(testConfigs[0].spec).hosted
  let result = AltGitFetcher.repoUrl(h)
  t.equal(result, 'git+' + h.sshurl())
  h.auth = "dummyAuthValueAgain"
  result = AltGitFetcher.repoUrl(h)
  t.equal(result, 'git+' + h.https())

  h.auth = null
  const oldHttps = h.https
  h.https = undefined
  result = AltGitFetcher.repoUrl(h)
  t.equal(result, 'git+' + h.sshurl())

  h.https = oldHttps
  const oldSshurl = h.sshurl
  h.sshurl = undefined
  result = AltGitFetcher.repoUrl(h)
  t.equal(result, 'git+' + h.https())

  h.sshurl = oldSshurl
  t.end()
})
tap.test('get types()', t => {
  const gitFetcher = new AltGitFetcher(testConfigs[0].spec, stdOpts)
  t.same(gitFetcher.types, [ 'git' ])
  t.end()
})

