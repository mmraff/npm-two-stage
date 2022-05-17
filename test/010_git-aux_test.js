/*
  download.js calls trackerKeys, fetchManifest (strictly for a git repo).
  git-offline.js calls resolve (strictly for a *local* git repo).
  offliner.js calls trackerKeys.
*/
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)

const expect = require('chai').expect
const npa = require('npm-package-arg')
const rimrafAsync = promisify(require('rimraf'))

const { copyFreshMockNpmDir } = require('./lib/tools')
const mockCommitHash = require('./lib/mock-commit-hash')

// The repo URLs are broken up to prevent conversion to active links
// in advanced text editors - too easy to click unintentionally.
const gitRefDocs = [
  {
    repoUrl: 'file:/' + '/arbitrary/path/one',
    refDoc: {
      versions: {
        '1.2.3': { sha: mockCommitHash(), ref: 'v1.2.3', type: 'tag' },
        '4.5.6': { sha: mockCommitHash(), ref: 'v4.5.6', type: 'tag' }
      },
      'dist-tags': {},
      refs: {
        master: { sha: mockCommitHash(), ref: 'master', type: 'branch' }
      },
      shas: null
    }
  },
  {
    repoUrl: 'file:/' + '/arbitrary/path/two',
    refDoc: {
      versions: {
        '0.1.2': { sha: mockCommitHash(), ref: 'v0.1.2', type: 'tag' },
        '3.4.5': { sha: mockCommitHash(), ref: 'v3.4.5', type: 'tag' }
      },
      'dist-tags': {},
      refs: {
        alternative: { sha: mockCommitHash(), ref: 'alternative', type: 'branch' }
      },
      shas: null
    }
  }
]
for (let i = 0; i < gitRefDocs.length; ++i) {
  const repoUrl = gitRefDocs[i].repoUrl
  const refDoc = gitRefDocs[i].refDoc
  const hashes = {}
  for (let ver in refDoc.versions) {
    versionItem = refDoc.versions[ver]
    refDoc.refs[versionItem.ref] = Object.assign({}, versionItem)
  }
  for (let ref in refDoc.refs) {
    const sha = refDoc.refs[ref].sha
    if (!hashes[sha]) hashes[sha] = []
    hashes[sha].push(ref)
  }
  refDoc.shas = hashes
}

const assets = {
  root: path.join(__dirname, 'tempAssets')
}
assets.dest = path.join(assets.root, 'npm', 'lib')
assets.nodeMods = path.join(assets.root, 'npm', 'node_modules')
const realSrcDir = path.resolve(__dirname, '..', 'src')
const mockSrcDir = path.join(__dirname, 'fixtures', 'self-mocks', 'src')

function copyToTestDir(relPath, opts) {
  if (!opts) opts = {}
  const srcPath = path.join(opts.mock ? mockSrcDir : realSrcDir, relPath)
  const newFilePath = path.join(assets.dest, relPath)
  const p = copyFileAsync(srcPath, newFilePath)
  return opts.getModule ? p.then(() => require(newFilePath)) : p
}

let gitAux
//let npm
let pickManifest
let utilGit

describe('git-aux module', function() {
  before('set up test directory', function(done) {
    rimrafAsync(assets.root).then(() => mkdirAsync(assets.root))
    .then(() => copyFreshMockNpmDir(assets.root))
    .then(() => {
      //npm = require(path.join(assets.dest, 'npm')) // don't need this?
      pickManifest = require(path.join(assets.nodeMods, 'npm-pick-manifest'))
      utilGit = require(path.join(assets.nodeMods, 'pacote', 'lib', 'util', 'git'))
    })
    .then(() => mkdirAsync(path.join(assets.dest, 'download')))
    .then(() =>
      copyToTestDir(path.join('download', 'git-aux.js'), { getModule: true })
      .then(mod => gitAux = mod)
    )
    .then(() => done())
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    rimrafAsync(assets.root).then(() => done())
    .catch(err => done(err))
  })

  const expectedExports = [ 'trackerKeys', 'resolve', 'fetchManifest' ]

  it('should export functions:' + expectedExports.join(', '), function() {
    for (let i = 0; i < expectedExports.length; ++i)
      expect(gitAux[expectedExports[i]]).to.be.a('function')
  })

  describe('trackerKeys', function() {
    it('should throw a SyntaxError given no/undefined/null argument', function() {
      expect(() => gitAux.trackerKeys()).to.throw(SyntaxError)
      expect(() => gitAux.trackerKeys(undefined)).to.throw(SyntaxError)
      expect(() => gitAux.trackerKeys(null)).to.throw(SyntaxError)
    })

    it('should throw a TypeError given argument that is not return value of npm-package-arg', function() {
      const wrongTypeArgs = [
        true, 42, 'hello-package@1.2.3', function(){}, [], { a: 'b' }
      ]
      for (let i = 0; i < wrongTypeArgs.length; ++i)
        expect(() => gitAux.trackerKeys(wrongTypeArgs[i])).to.throw(TypeError)
    })

    it('should throw a TypeError given npm-package-arg result with type != "git"', function() {
      const npaSpec = npa('hello-package@1.2.3')
      expect(() => gitAux.trackerKeys(npaSpec)).to.throw(TypeError)
    })

    it('should return an object with "repo" and "spec" properties for a valid git spec at a well-known host', function() {
      const hostedPath = 'gh-user/project-name'
      const committish = 'a0b1c2d3e4f56789a0b1c2d3e4f56789a0b1c2d3'
      const npaSpec = npa(hostedPath + '#' + committish)
      const result = gitAux.trackerKeys(npaSpec)
      expect(result).to.have.property('repo').that.equals('github.com/' + hostedPath)
      expect(result).to.have.property('spec').that.equals(committish)
    })

    it('should return an object with "repo" and "spec" properties for a full git spec at an arbitrary host', function() {
      const repo = 'somehost.org/someuser/project-name'
      const committish = '"semver:>2.0 <4"'
      const npaSpec = npa(`git://${repo}.git#${committish}`)
      const result = gitAux.trackerKeys(npaSpec)
      expect(result).to.have.property('repo').that.equals(repo)
      expect(result).to.have.property('spec').that.equals(committish)
    })

    it('should have an empty string for the "spec" property if given spec has no committish', function() {
      const hostedPath = 'gh-user/project-name'
      const npaSpec = npa(hostedPath)
      const result = gitAux.trackerKeys(npaSpec)
      expect(result).to.have.property('repo').that.equals('github.com/' + hostedPath)
      expect(result).to.have.property('spec').that.is.a('string').that.is.empty
    })

    it('should return null for git spec at arbitrary host that cannot be URL-parsed', function() {
      const npaSpec = npa('git:/' + '/#!%&*!#$)!')
      expect(gitAux.trackerKeys(npaSpec)).to.be.null
    })
  })

  describe('resolve', function() {
    it('should yield expected metadata for a git spec with no commit or version Id', function(done) {
      const npaSpec = npa('git+ssh:/' + '/gittar.com/gtuser/gtproject.git')
      const name = 'test1'
      const chosenRef = 'master'
      const refAssoc = gitRefDocs[0]
      const expectedData = refAssoc.refDoc.refs[chosenRef]
      utilGit.setTestConfig({ [refAssoc.repoUrl]: refAssoc.refDoc })
      gitAux.resolve(refAssoc.repoUrl, npaSpec, name, { multipleRefs: true })
      .then(result => {
        expect(result).to.deep.equal(expectedData)
        done()
      })
      .catch(err => done(err))
    })

    it('as above, where the repo default branch has an unconventional name', function(done) {
      const npaSpec = npa('git+ssh:/' + '/gittar.com/gtuser/gtproject.git')
      const name = 'test2'
      const chosenRef = 'alternative'
      const refAssoc = gitRefDocs[1]
      const expectedData = refAssoc.refDoc.refs[chosenRef]
      utilGit.setTestConfig({ [refAssoc.repoUrl]: refAssoc.refDoc })
      gitAux.resolve(refAssoc.repoUrl, npaSpec, name, { multipleRefs: true })
      .then(result => {
        expect(result).to.deep.equal(expectedData)
        done()
      })
      .catch(err => done(err))
    })

    it('should yield expected metadata for a git spec with a semver range', function(done) {
      // This is the only case where pickManifest gets called.
      const npaSpec = npa('git+ssh:/' + '/gittar.com/gtuser/gtproject.git#semver:>4.2')
      const name = 'test3'
      const chosenVer = '4.5.6'
      const refAssoc = gitRefDocs[0]
      const expectedData = refAssoc.refDoc.versions[chosenVer]
      utilGit.setTestConfig({ [refAssoc.repoUrl]: refAssoc.refDoc })
      pickManifest.setTestConfig({
        name: name, keys: { section: 'versions', ref: chosenVer }
      })
      gitAux.resolve(refAssoc.repoUrl, npaSpec, name, { multipleRefs: true })
      .then(result => {
        expect(result).to.deep.equal(expectedData)
        done()
      })
      .catch(err => done(err))
    })

    it('should yield expected metadata for a git spec with a commit hash', function(done) {
      const name = 'test4'
      const refAssoc = gitRefDocs[0]
      const chosenSha = Object.keys(refAssoc.refDoc.shas)[1]
      const npaSpec = npa('git+ssh:/' + '/gittar.com/gtuser/gtproject.git#' + chosenSha)
      const ref = refAssoc.refDoc.shas[chosenSha][0]
      const expectedData = refAssoc.refDoc.refs[ref]
      utilGit.setTestConfig({ [refAssoc.repoUrl]: refAssoc.refDoc })
      gitAux.resolve(refAssoc.repoUrl, npaSpec, name, { multipleRefs: true })
      .then(result => {
        expect(result).to.deep.equal(expectedData)
        done()
      })
      .catch(err => done(err))
    })
  })

function expectManifest(actualData, npaSpec, revDoc, protocol) {
  const opts = { noCommittish: true }
  let expectedResolved
  if (npaSpec.hosted && npaSpec.hosted.default) {
    const dft = npaSpec.hosted.default
    expectedResolved = npaSpec.hosted[dft](opts) + '#' + revDoc.sha
  }
  else {
    //console.log('PROBLEM SPEC handed to expectManifest:', npaSpec)
    throw new Error('Unable to deal with this spec')
  }

  const expectedResult = {
    _repo: protocol ? npaSpec.hosted[protocol]() : npaSpec.hosted.git(),
    _resolved: expectedResolved,
    _spec: npaSpec,
    _ref: revDoc,
    _rawRef: npaSpec.gitCommittish || npaSpec.gitRange,
    _uniqueResolved: expectedResolved,
    _integrity: false,
    _shasum: false
  }
  expect(actualData).to.deep.equal(expectedResult)
}
  describe('fetchManifest', function() {
    it('should reject if given corrupted result of npm-package-arg for git repo spec', function(done) {
      const rawSpec = 'gitlab:gluser/\n' // this results in no hosted.git()
      const npaSpec = npa(rawSpec)
      // Make the error cascade through the other two checks:
      npaSpec.hosted.httpstemplate = null
      npaSpec.hosted.sshurltemplate = null
      gitAux.fetchManifest(npaSpec, { multipleRefs: true })
      .then(result => done(new Error('Should have rejected')))
      .catch(err => {
        expect(err).to.match(/No git url/)
        done()
      })
    })

    it('should yield expected manifest for shortcut spec to git repo on well-known host', function(done) {
      const rawSpec = 'ghuser/ghproject#v4.5.6'
      const npaSpec = npa(rawSpec)
      const chosenRef = 'v4.5.6'
      const refAssoc = gitRefDocs[0]
      const expectedRefData = refAssoc.refDoc.refs[chosenRef]
      utilGit.setTestConfig({ [npaSpec.hosted.git()]: refAssoc.refDoc })
      gitAux.fetchManifest(npaSpec, { multipleRefs: true })
      .then(result => {
        expectManifest(result, npaSpec, expectedRefData)
        done()
      })
      .catch(err => done(err))
    })

    it('same as above with no commit or version Id', function(done) {
      const npaSpec = npa('ghuser/ghproject')
      const chosenRef = 'master'
      const refAssoc = gitRefDocs[0]
      const expectedRefData = refAssoc.refDoc.refs[chosenRef]
      utilGit.setTestConfig({ [npaSpec.hosted.git()]: refAssoc.refDoc })
      gitAux.fetchManifest(npaSpec, { multipleRefs: true })
      .then(result => {
        expectManifest(result, npaSpec, expectedRefData)
        // Now we go through the fallbacks that are set up to accomodate the
        // different protocols that might be in place on different host sites:
        utilGit.setTestConfig({ [npaSpec.hosted.https()]: refAssoc.refDoc })
        return gitAux.fetchManifest(npaSpec, { multipleRefs: true })
      })
      .then(result => {
        expectManifest(result, npaSpec, expectedRefData, 'https')
        utilGit.setTestConfig({ [npaSpec.hosted.sshurl()]: refAssoc.refDoc })
        return gitAux.fetchManifest(npaSpec, { multipleRefs: true })
      })
      .then(result => {
        expectManifest(result, npaSpec, expectedRefData, 'sshurl')
        done()
      })
      .catch(err => done(err))
    })

    it('should yield expected manifest for git repo on arbitrary host', function(done) {
      const npaSpec = npa('git:/' + '/gittar.com/gtuser/gtproject.git')
      const refAssoc = gitRefDocs[0]
      const expectedRefData = refAssoc.refDoc.refs['master']
      utilGit.setTestConfig({ [npaSpec.fetchSpec]: refAssoc.refDoc })
      gitAux.fetchManifest(npaSpec, { multipleRefs: true })
      .then(result => {
        const expectedResolved = npaSpec.raw + '#' + expectedRefData.sha
        const expectedResult = {
          _repo: npaSpec.fetchSpec,
          _resolved: expectedResolved,
          _spec: npaSpec,
          _ref: expectedRefData,
          _rawRef: undefined,
          _uniqueResolved: expectedResolved,
          _integrity: false,
          _shasum: false
        }
        expect(result).to.deep.equal(expectedResult)
        done()
      })
      .catch(err => done(err))
    })

    it('should yield expected manifest when commit cannot be determined', function(done) {
      // This uses a hack in mock pickManifest to get resolve() to return
      // nothing for ref, so that the 'else' branch can be visited.
      const committish = '0123456789'
      const npaSpec = npa('git+ssh:/' + '/gittar.com/gtuser/gtproject.git#' + committish)
      const refAssoc = gitRefDocs[0]
      utilGit.setTestConfig({ [npaSpec.fetchSpec]: null })
      pickManifest.setTestConfig(null)
      gitAux.fetchManifest(npaSpec, { multipleRefs: true })
      .then(result => {
        const expectedResult = {
          _repo: npaSpec.fetchSpec,
          _rawRef: committish,
          _resolved: null,
          _uniqueResolved: null,
          _integrity: false,
          _shasum: false
        }
        expect(result).to.deep.equal(expectedResult)
        done()
      })
    })
  })
})
