const Emitter = require('events')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const renameAsync = promisify(fs.rename)
const unlinkAsync = promisify(fs.unlink)
const writeFileAsync = promisify(fs.writeFile)

const mkdirpAsync = promisify(require('mkdirp'))
const rimrafAsync = promisify(require('rimraf'))
const { expect } = require('chai')

const { graft } = require('../lib/file-tools')
const testTools = require('./lib/tools')

const {
  targets: TGTS,
  backupFlag: BAKFLAG,
  errorCodes: ERRS
} = require('../lib/constants')

const assets = {
  root: path.join(__dirname, 'tempAssets')
}
assets.emptyDir = path.join(assets.root, 'EMPTY_DIR')
assets.wrongDir = path.join(assets.root, 'not-npm')
assets.npmDir = path.join(assets.root, 'npm')
assets.installDest = path.join(assets.npmDir, 'lib')
assets.n2sMockLibPath = path.join(assets.root, 'lib')
assets.n2sMockSrcPath = path.join(assets.root, 'src')

const mock = {}
const realSrcDir = path.resolve(__dirname, '..', 'src')
const wrongVersionPJFile = path.join(
  __dirname, 'fixtures', 'npm-wrong-version-package.json'
)

const msgPatterns = [
  /^Checking npm version/,
  /^Target npm home is/,
  /^Removing items added/,
  /^Restoring backed-up original files/
]

function expectStandardMessages(msgList, size) {
  expect(msgList).have.lengthOf.at.least(size)
  for (let i = 0; i < size; ++i)
    expect(msgList[i]).to.match(msgPatterns[i])
}

function getDidNotReject() {
  return new Error('Failed to get expected rejection')
}

describe('`uninstall` module', function() {
  let targetMod // The target module, uninstall.js

  before('set up test directory', function(done) {
    const fixtureLibPath = path.join(__dirname, 'fixtures', 'self-mocks', 'lib')
    const targetModPath = path.join(assets.n2sMockLibPath, 'uninstall.js')
    rimrafAsync(assets.root).then(() => mkdirAsync(assets.root))
    .then(() => graft(realSrcDir, assets.root))
    .then(() => graft(fixtureLibPath, assets.root))
    .then(() => copyFileAsync(
      path.join(__dirname, '..', 'lib', 'uninstall.js'), targetModPath
    ))
    .then(() => {
      mock.constants = require(path.join(assets.n2sMockLibPath, 'constants.js'))
      mock.shared = require(path.join(assets.n2sMockLibPath, 'shared.js'))
      targetMod = require(targetModPath)
    })
    .then(() => mkdirAsync(assets.emptyDir))
    .then(() => mkdirAsync(assets.wrongDir))
    .then(() => copyFileAsync(
      path.join(__dirname, 'fixtures', 'dummy', 'package.json'),
      path.join(assets.wrongDir, 'package.json')
    ))
    .then(() => testTools.copyFreshMockNpmDir(assets.root))
    .then(() => done())
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    rimrafAsync(assets.root).then(() => done())
    .catch(err => done(err))
  })

  it('should export an emitter named `uninstallProgress`', function() {
    expect(targetMod).to.have.property('uninstallProgress')
    .that.is.an.instanceof(Emitter)
  })

  it('should export a function named `uninstall`', function() {
    expect(targetMod).to.have.property('uninstall').that.is.a('function')
  })

  describe('`uninstall` function', function() {
    const messages = []

    before('setup for all `uninstall` tests', function() {
      targetMod.uninstallProgress.on('msg', (msg) => messages.push(msg))
    })

    afterEach('per-item teardown', function() {
      messages.splice(0, messages.length)
    })

    after('teardown after all `uninstall` tests', function() {
      targetMod.uninstallProgress.removeAllListeners()
    })

    it('should reject if checking the npm version at the target gets a rejection', function(done) {
      mock.shared.setErrorState('expectCorrectNpmVersion', true, 'ENOENT')
      targetMod.uninstall(path.join(assets.root, 'NOSUCHDIR'))
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        mock.shared.setErrorState('expectCorrectNpmVersion', false)
        expect(err.code).to.equal('ENOENT')
        expectStandardMessages(messages, 1)
        done()
      })
      .catch(err => done(err))
    })

    /*
      This is risky, because in the (unlikely) event that the uninstall code is wrong,
      and the running process just happens to have admin privileges, the call could
      succeed, and unintentionally remove npm-two-stage from the global npm
      (if it's there).
    */
    it('should reject if global npm is the target and has wrong version', function(done) {
      mock.shared.setErrorState('expectCorrectNpmVersion', true)
      targetMod.uninstall().then(() => { throw getDidNotReject() })
      .catch(err => {
        mock.shared.setErrorState('expectCorrectNpmVersion', false)
        expectStandardMessages(messages, 1)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if base directory "lib" is missing from npm installation at given path', function(done) {
      copyFileAsync(
        path.join(assets.npmDir, 'package.json'),
        path.join(assets.wrongDir, 'package.json')
      )
      // Here there's a package.json to check, but not a lib dir to chdir into
      .then(() => targetMod.uninstall(assets.wrongDir))
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.BAD_NPM_INST)
        expectStandardMessages(messages, 2)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if shared.removeAddedItems() rejects', function(done) {
      mock.shared.setErrorState('removeAddedItems', true, 'EACCES')
      // Pick up where we left off with the incomplete mock npm installation
      mkdirAsync(path.join(assets.wrongDir, 'lib'))
      // Now at least uninstall() can chdir into lib...
      .then(() => targetMod.uninstall(assets.wrongDir))
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        mock.shared.setErrorState('removeAddedItems', false)
        //expect(err.exitcode).to.equal(ERRS.FS_ACTION_FAIL) // not from the mock
        expectStandardMessages(messages, 3)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if shared.restoreBackups() rejects', function(done) {
      mock.shared.setErrorState('restoreBackups', true, 'ENOENT')
      targetMod.uninstall(assets.wrongDir)
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        mock.shared.setErrorState('restoreBackups', false)
        //expect(err.exitcode).to.equal(ERRS.FS_ACTION_FAIL) // not from the mock
        expectStandardMessages(messages, 4)
        done()
      })
      .catch(err => done(err))
    })

    it('should succeed given expected conditions at the target', function(done) {
      targetMod.uninstall(assets.wrongDir)
      .then(() => {
        expectStandardMessages(messages, 4)
        done()
      })
      .catch(err => done(err))
    })
  })
})
