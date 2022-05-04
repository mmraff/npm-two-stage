const child_process = require('child_process')
const originalExecFile = child_process.execFile
// Monkey patch! To prevent spawning of executables in these tests
child_process.execFile = function(file, args, opts, cb) {
  cb(null, { stdout: 'howdy\n', stderr: '' })
}
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)

const expect = require('chai').expect
const npa = require('npm-package-arg')
const rimrafAsync = promisify(require('rimraf'))

const { copyFreshMockNpmDir } = require('./lib/tools')
const { graft } = require('../lib/file-tools')

let gitOffline
let mockLog
let mockNpm
let mockReadJson
let mockTar
let mockGitContext

const assets = {
  root: path.join(__dirname, 'tempAssets')
}
assets.npmLib = path.join(assets.root, 'npm', 'lib')
assets.npmModules = path.join(assets.root, 'npm', 'node_modules')
assets.temp = path.join(assets.root, 'tmp')
const realSrc = path.resolve(__dirname, '..', 'src')
const mockSrc = path.join(__dirname, 'fixtures', 'self-mocks', 'src')

const testData = {
  spec: 'https:' + '//bitbucket.org/someuser/some-project.git',
  dlt: {
    type: 'git', spec: this.spec,
    repoID: 'bitbucket_org_someuser_some-project_2d7e5f'
  }
}
// Will be set to what git-offline should put in the resolved data:
let expectedPath

describe('git-offline module', function() {
  before('set up test directory', function(done) {
    rimrafAsync(assets.root)
    .catch(err => { if (err.code != 'ENOENT') throw err })
    .then(() => mkdirAsync(assets.root))
    .then(() => mkdirAsync(assets.temp))
    .then(() => copyFreshMockNpmDir(assets.root))
    .then(() => {
      // So that we can access the dlTracker and set the temporary directory:
      mockNpm = require(path.join(assets.npmLib, 'npm'))
      mockNpm.tmp = assets.temp
      // So that we can inject test data:
      mockReadJson = require(path.join(assets.npmModules, 'read-package-json'))
      // So that we can retrieve/remove logged messages:
      mockLog = require(path.join(assets.npmModules, 'npmlog'))
      // So that we can force an error from tar.create:
      mockTar = require(path.join(assets.npmModules, 'tar'))

      const depFile = 'prepare-raw-module.js'
      return copyFileAsync(
        path.join(mockSrc, depFile), path.join(assets.npmLib, depFile)
      )
    })
    .then(() => graft(path.join(mockSrc, 'download'), assets.npmLib))
    .then(() => {
      mockGitContext = require(path.join(assets.npmLib, 'download', 'git-context'))
      expectedPath = path.resolve(
        assets.temp,
        mockGitContext.dirNames.offlineTemps,
        testData.dlt.repoID,
        'package.tgz'
      )

      const tgtFile = 'git-offline.js'
      return copyFileAsync(
        path.join(realSrc, tgtFile), path.join(assets.npmLib, tgtFile)
      )
      .then(() => gitOffline = require(path.join(assets.npmLib, tgtFile)))
    })
    .then(() => done())
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    child_process.execFile = originalExecFile
    rimrafAsync(assets.root).then(() => done())
    .catch(err => done(err))
  })

  afterEach('cleanup in between tests', function() {
    mockTar.reset()
    mockLog.purge()
  })

  it('should throw if not given a callback (as the 4th argument)', function() {
    // We also squeeze coverage in for (opts !== undefined && opts !== null)
    // which don't really justify tests with opts undefined or null
    expect(function(){ gitOffline() }).to.throw(/not a function/)
    expect(function(){ gitOffline(npa(testData.spec), testData.dlt) })
    .to.throw(/not a function/)
    expect(function(){ gitOffline(npa(testData.spec), testData.dlt, null, {}) })
    .to.throw(/not a function/)
  })

  it('should send back a SyntaxError if given nothing for package spec', function(done) {
    gitOffline(undefined, {}, {}, function(err) {
      expect(err).to.be.an.instanceof(SyntaxError)
      expect(err.message).to.match(/First argument/)
      done()
    })
  })

  it('should send back a TypeError if given package spec is not an object', function(done) {
    gitOffline(testData.spec, {}, {}, function(err) {
      expect(err).to.be.an.instanceof(TypeError)
      expect(err.message).to.match(/First argument/)
      done()
    })
  })

  it('should send back a TypeError if "type" property is not a string in given package spec', function(done) {
    const npaSpec = npa(testData.spec)
    npaSpec.type = 42
    gitOffline(npaSpec, {}, {}, function(err) {
      expect(err).to.be.an.instanceof(TypeError)
      expect(err.message).to.match(/First argument/)
      done()
    })
  })

  it('should send back a SyntaxError if given nothing for download data', function(done) {
    gitOffline(npa(testData.spec), null, {}, function(err) {
      expect(err).to.be.an.instanceof(SyntaxError)
      expect(err.message).to.match(/Second argument/)
      done()
    })
  })

  it('should send back a TypeError if given download data arg is not an object', function(done) {
    gitOffline(npa(testData.spec), 'hello', {}, function(err) {
      expect(err).to.be.an.instanceof(TypeError)
      expect(err.message).to.match(/Second argument/)
      done()
    })
  })

  it('should send back a TypeError if "type" property is not a string in given download data', function(done) {
    gitOffline(npa(testData.spec), { type: 42 }, {}, function(err) {
      expect(err).to.be.an.instanceof(TypeError)
      expect(err.message).to.match(/Second argument/)
      done()
    })
  })

  it('should send back a TypeError if type of download data is not "git"', function(done) {
    const dlData = Object.assign({}, testData.dlt)
    dlData.type = 'url'
    gitOffline(npa(testData.spec), dlData, {}, function(err) {
      expect(err).to.be.an.instanceof(TypeError)
      expect(err.message).to.match(/Invalid dlTracker data/)
      done()
    })
  })

  it('should send back a TypeError if download data has no value for "repoID"', function(done) {
    const dlData = Object.assign({}, testData.dlt)
    delete dlData.repoID
    gitOffline(npa(testData.spec), dlData, {}, function(err) {
      expect(err).to.be.an.instanceof(TypeError)
      expect(err.message).to.match(/Invalid dlTracker data/)
      done()
    })
  })

  it('should send back a TypeError if options argument is given but is not an object', function(done) {
    gitOffline(npa(testData.spec), testData.dlt, 42, function(err) {
      expect(err).to.be.an.instanceof(TypeError)
      expect(err.message).to.match(/third argument/)
      done()
    })
  })

  it('should send back specific error "ENOGIT" if a git executable is not available', function(done) {
    const oldPathGit = mockGitContext.gitPath
    mockGitContext.gitPath = ''
    gitOffline(npa(testData.spec), testData.dlt, {}, function(err) {
      expect(err).to.match(/No git binary/)
      expect(err.code).to.equal('ENOGIT')
      mockGitContext.gitPath = oldPathGit
      // The mockLog has no messages here.
      done()
    })
  })

  it('should send back an error if the tarball path already exists and is inaccessible/not a file', function(done) {
    mockTar.setError(`illegal operation on a directory, open '${expectedPath}'`, 'EISDIR')
    gitOffline(npa(testData.spec), testData.dlt, {}, function(err) {
      let assertError
      try {
        expect(err).to.match(/"package\.tgz" directory obstructing/)
        expect(err.code).to.equal('EISDIR')
      }
      catch (err2) { assertError = err2 }
      // The mockLog has no messages here.
      mockTar.setError(null)
      done(assertError)
    })
  })

  it('should send back the npa parse result for a tarball at the expected temp path', function(done) {
    gitOffline(npa(testData.spec), testData.dlt, {}, function(err, data) {
      if (err) return done(err)
      expect(mockTar.succeeded()).to.be.true
      expect(data.type).to.equal('file')
      expect(data.raw).to.equal(expectedPath)
      expect(mockLog.messages()).to.be.empty
      done()
    })
  })

  it('should succeed for a git repo with "prepare" script and devDependencies that are all present', function(done) {
    mockReadJson.setTestCase({
      name: 'some-project',
      scripts: 'prepare',
      devDeps: { 'dummy-tester': '11.11.11' }
    })
    mockNpm.dlTracker.add(
      'semver',
      { name: 'dummy-tester', version: '11.11.11', filename: 'whatever.tgz' },
      function() {
        gitOffline(npa(testData.spec), testData.dlt, {}, function(err, data) {
          if (err) return done(err)
          expect(mockTar.succeeded()).to.be.true
          expect(data.type).to.equal('file')
          expect(data.raw).to.equal(expectedPath)
          expect(mockLog.messages()).to.be.empty
          done()
        })
      }
    )
  })

  it('should succeed but emit warnings for a git repo with "prepare" script and an unparseable devDependency', function(done) {
    mockReadJson.setTestCase({
      name: 'some-project',
      scripts: 'prepare',
      devDeps: { '!@#$%^&': '42' }
    })
    gitOffline(npa(testData.spec), testData.dlt, {}, function(err, data) {
      if (err) return done(err)
      expect(mockTar.succeeded()).to.be.true
      expect(data.type).to.equal('file')
      expect(data.raw).to.equal(expectedPath)
      const msgs = mockLog.messages()
      expect(msgs).to.have.lengthOf(2)
      expect(msgs[0].level).to.equal('warn')
      expect(msgs[0].prefix).to.equal('checkRepoDevDeps')
      expect(msgs[0].message).to.match(/could not parse devDependency/)
      expect(msgs[1].level).to.equal('warn')
      expect(msgs[1].prefix).to.equal('checkRepoDevDeps')
      expect(msgs[1].message).to.match(/run the prepare script manually/)
      done()
    })
  })

  it('should succeed but emit warnings for a git repo with "prepare" script and devDependency of unhandled type', function(done) {
    mockReadJson.setTestCase({
      name: 'some-project',
      scripts: 'prepare',
      devDeps: { 'my/local/linter': '42' }
    })
    gitOffline(npa(testData.spec), testData.dlt, {}, function(err, data) {
      if (err) return done(err)
      expect(mockTar.succeeded()).to.be.true
      expect(data.type).to.equal('file')
      expect(data.raw).to.equal(expectedPath)
      const msgs = mockLog.messages()
      expect(msgs).to.have.lengthOf(2)
      expect(msgs[0].level).to.equal('warn')
      expect(msgs[0].prefix).to.equal('checkRepoDevDeps')
      expect(msgs[0].message).to.match(/unrecognized type [^ ]+ of devDependency/)
      expect(msgs[1].level).to.equal('warn')
      expect(msgs[1].prefix).to.equal('checkRepoDevDeps')
      expect(msgs[1].message).to.match(/run the prepare script manually/)
      done()
    })
  })

  it('should succeed but emit warnings for a git repo with "prepare" script and devDependencies that were not downloaded', function(done) {
    mockReadJson.setTestCase({
      name: 'some-project',
      scripts: 'prepare',
      devDeps: { 'dummy-tester': '^11' }
    })
    gitOffline(npa(testData.spec), testData.dlt, {}, function(err, data) {
      if (err) return done(err)
      expect(mockTar.succeeded()).to.be.true
      expect(data.type).to.equal('file')
      expect(data.raw).to.equal(expectedPath)
      const msgs = mockLog.messages()
      expect(msgs).to.have.lengthOf(2)
      expect(msgs[0].level).to.equal('warn')
      expect(msgs[0].prefix).to.equal('checkRepoDevDeps')
      expect(msgs[0].message).to.match(/devDependency [^ ]+ not present/)
      expect(msgs[1].level).to.equal('warn')
      expect(msgs[1].prefix).to.equal('checkRepoDevDeps')
      expect(msgs[1].message).to.match(/run the prepare script manually/)
      done()
    })
  })

})
