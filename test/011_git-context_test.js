const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const execAsync = promisify(require('child_process').exec)
const lstatAsync = promisify(fs.lstat)
const writeFileAsync = promisify(fs.writeFile)

const expect = require('chai').expect
const mkdirpAsync = promisify(require('mkdirp'))
const rimrafAsync = promisify(require('rimraf'))

// The only non-built-in dependencies of the target module are already
// among our devDependencies.
// No need for mocks --> no need for a displaced copy of the target
const gitContext = require('../src/download/git-context')

const assets = {
  root: path.join(__dirname, 'gitContext')
}
// Need a place for getGitRepoDir to operate on:
assets.correctBasePath = path.join(assets.root, 'mockReposDir')

describe('git-context module', function() {
  let gitEnvMap

  before('set up test directory', function(done) {
    rimrafAsync(assets.root)
    .then(() => mkdirpAsync(assets.correctBasePath))
    .then(() => done())
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    rimrafAsync(assets.root).then(() => done())
    .catch(err => done(err))
  })

  it('should export an object "dirNames"', function() {
    const dirNames = gitContext.dirNames
    expect(dirNames).to.be.an('object')
    .that.has.all.keys('remotes', 'template', 'offlineTemps')
    expect(dirNames.remotes).to.be.a('string').that.is.not.empty
    expect(dirNames.template).to.be.a('string').that.is.not.empty
    expect(dirNames.offlineTemps).to.be.a('string').that.is.not.empty
  })

  it('should export the path of the local git executable as "gitPath"', function(done) {
    // Although gitContext does not insist that one must exist, if we get a
    // non-empty value, it should be an actual executable git
    expect(gitContext).to.have.property('gitPath')
    const gitPath = gitContext.gitPath
    if (gitPath) {
      execAsync(gitPath + ' --version')
      .then(({ stdout }, stderr) => {
        expect(stdout.trim()).to.match(/^git version /)
        done()
      })
      .catch(err => done(err))
    }
    else done()
  })

  const expectedExports = [ 'gitEnv', 'mkOpts', 'getGitRepoDir' ]

  it('should export functions: ' + expectedExports.join(', '), function() {
    for (let i = 0; i < expectedExports.length; ++i)
      expect(gitContext[expectedExports[i]]).to.be.a('function')
  })

  describe('gitEnv', function() {
    it('should return a mapping of select environment variables and their values', function() {
      // First put a dummy variable with 'GIT_' prefix into the environment
      // (for coverage of that one line where invalid GIT_ vars are filtered out)
      process.env.GIT_OUT_OF_HERE = 'ridiculous'
      gitEnvMap = gitContext.gitEnv()
      expect(gitEnvMap).to.be.an('object').that.has.property('GIT_ASKPASS', 'echo')
      for (let varname in gitEnvMap) {
        if (varname !== 'GIT_ASKPASS')
          expect(gitEnvMap[varname]).to.equal(process.env[varname])
      }
    })
    it('should return the same thing in subsequent call (when environment has not changed)', function() {
      expect(gitContext.gitEnv()).to.deep.equal(gitEnvMap)
    })
  })

  describe('mkOpts', function() {
    let result
    it('should return an object with nothing but a "env" property if given (null, {})', function() {
      result = gitContext.mkOpts(null, {})
      expect(result).to.be.an('object').that.has.property('env')
      expect(result).to.not.have.any.keys('uid', 'gid')
    })
    it('should have "uid" and/or "gid" properties iff valid values are given in opts *and* the user is root', function() {
      result = gitContext.mkOpts({}, { uid: 0/0, gid: 0/0 })
      expect(result).to.be.an('object').that.has.property('env')
      expect(result).to.not.have.any.keys('uid', 'gid')

      result = gitContext.mkOpts({}, { uid: 1001, gid: 1002 })
      expect(result).to.be.an('object').that.has.property('env')
      expect(result).to.not.have.any.keys('uid', 'gid')

      const originalGetuid = process.getuid
      process.getuid = () => 0
      result = gitContext.mkOpts({}, { uid: 1001, gid: 1002 })
      if (!originalGetuid) delete process.getuid
      else process.getuid = originalGetuid
      expect(result).to.be.an('object').that.has.property('env')
      expect(result).to.have.property('uid', 1001)
      expect(result).to.have.property('gid', 1002)
    })
    it('"env" property should have the same value as gitEnv()', function() {
      expect(result.env).to.deep.equal(gitEnvMap)
    })
  })

  describe('getGitRepoDir', function() {
    const failedToReject_msg = 'Should have rejected'

    it('should reject with a SyntaxError if nothing/empty value given', function(done) {
      gitContext.getGitRepoDir()
      .then(() => { throw new Error(failedToReject_msg) })
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        done()
      })
      .catch(err => done(err))
    })
    it('should reject with a TypeError if given value is not a string', function(done) {
      gitContext.getGitRepoDir(42)
      .then(() => { throw new Error(failedToReject_msg) })
      .catch(err => {
        expect(err).to.be.an.instanceof(TypeError)
        done()
      })
      .catch(err => done(err))
    })
    it('should reject if given a path that does not exist in the filesystem', function(done) {
      gitContext.getGitRepoDir(path.join(assets.root, 'NO_SUCH_PATH'))
      .then(() => { throw new Error(failedToReject_msg) })
      .catch(err => {
        expect(err.code).to.equal('ENOENT')
        done()
      })
      .catch(err => done(err))
    })
    it('should reject if given a path that is not a directory', function(done) {
      const filePath = path.join(assets.root, 'I_AM_NOT_A_DIR')
      writeFileAsync(filePath, 'ignore this dummy text')
      .then(() => gitContext.getGitRepoDir(filePath))
      .then(() => { throw new Error(failedToReject_msg) })
      .catch(err => {
        expect(err.code).to.equal('EEXIST')
        done()
      })
      .catch(err => done(err))
    })
    it('should resolve to the full path of a new subdirectory of the given directory', function(done) {
      gitContext.getGitRepoDir(assets.correctBasePath)
      .then(dir => {
        expect(path.dirname(dir)).to.equal(assets.correctBasePath)
        return lstatAsync(dir).then(stats => {
          expect(stats.isDirectory()).to.be.true
          done()
        })
      })
      .catch(err => done())
    })
  })
})
