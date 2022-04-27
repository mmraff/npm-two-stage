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
  //targetVersion: EXPECTED_NPM_VER,
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

  describe('`install` function', function() {
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
  })
})
