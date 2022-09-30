const Emitter = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const execAsync = promisify(require('child_process').exec)
const renameAsync = promisify(fs.rename)
const unlinkAsync = promisify(fs.unlink)
const writeFileAsync = promisify(fs.writeFile)

const mkdirpAsync = promisify(require('mkdirp'))
const rimrafAsync = promisify(require('rimraf'))
const { expect } = require('chai')

const testTools = require('./lib/tools')

const assetsRootName = 'n2s_shared'
const assetsRoot = path.join(__dirname, assetsRootName)

const mock = {}
const mockNpmTarget = path.join(assetsRoot, 'npm')

const {
  targetVersion: EXPECTED_NPM_VER,
  targets: TGTS,
  backupFlag: BAKFLAG,
  errorCodes: ERRS
} = require('../lib/constants')

function getDidNotReject() {
  return new Error('Failed to get expected rejection')
}

function makeMockBackups(i) {
  if (i >= TGTS.CHANGED_FILES.length) return Promise.resolve()
  const oldName = TGTS.CHANGED_FILES[i]
  const backupName = path.normalize(`${oldName}${BAKFLAG}.js`)
  return renameAsync(path.normalize(oldName + '.js'), backupName)
  .then(() => makeMockBackups(i+1))
}

describe('`shared` module', function() {
  const exportedFuncs = [
    'expectCorrectNpmVersion', 'removeAddedItems', 'restoreBackups'
  ]
  let shared // The target module

  before('set up temp assets', function(done) {
    const fixtureLibPath = path.join(__dirname, 'fixtures/self-mocks/lib')
    const mockN2sLibPath = path.join(assetsRoot, 'lib')
    const mocksRequirePrefix = `./${assetsRootName}/lib/`
    rimrafAsync(assetsRoot)
    .catch(err => { if (err.code != 'ENOENT') throw err })
    .then(() => mkdirpAsync(mockN2sLibPath))
    .then(() => copyFileAsync(
      path.join(fixtureLibPath, 'constants.js'),
      path.join(mockN2sLibPath, 'constants.js')
    ))
    .then(() => copyFileAsync(
      path.join(fixtureLibPath, 'file-tools.js'),
      path.join(mockN2sLibPath, 'file-tools.js')
    ))
    .then(() => copyFileAsync(
      path.resolve(__dirname, '../lib/shared.js'),
      path.join(mockN2sLibPath, 'shared.js')
    ))
    .then(() => {
      mock.constants = require(mocksRequirePrefix + 'constants.js')
      mock.ft = require(mocksRequirePrefix + 'file-tools.js')
      shared = require(mocksRequirePrefix + 'shared.js')
    })
    .then(() => mkdirpAsync(path.join(mockNpmTarget, 'lib')))
    .then(() => done())
    .catch(err => done(err))
  })

  after('tear down temp assets', function(done) {
    rimrafAsync(assetsRoot).then(() => done())
    .catch(err => done(err))
  })

  it('should export an events Emitter named `emitter`', function() {
    expect(shared).to.have.property('emitter').that.is.an.instanceof(Emitter)
  })

  it(`should export functions: ${exportedFuncs.join(', ')}`, function() {
    for (let i = 0; i < exportedFuncs.length; ++i)
      expect(shared).to.have.property(exportedFuncs[i]).that.is.a('function')
  })

  describe('`expectCorrectNpmVersion` function', function() {
    // Note: this function does not use the emitter.

    it('should reject with exitcode NO_NPM if no response from npm', function(done) {
      const origPATHval = process.env.PATH
      process.env.PATH = ''
      shared.expectCorrectNpmVersion().then(() => {
        process.env.PATH = origPATHval
        done(getDidNotReject())
      })
      .catch(err => {
        process.env.PATH = origPATHval
        expect(err.exitcode).to.equal(ERRS.NO_NPM)
        done()
      })
      .catch(err => done(err))
    })

    it('should succeed if global npm is the target and has matching version', function(done) {
      const oldTgtVersion = mock.constants.targetVersion
      execAsync('npm --version').then(({ stdout }, stderr) => {
        const actualNpmVer = stdout.trim()
        mock.constants.targetVersion = actualNpmVer
        return shared.expectCorrectNpmVersion()
      })
      .then(() => {
        mock.constants.targetVersion = oldTgtVersion
        done()
      })
      .catch(err => {
        mock.constants.targetVersion = oldTgtVersion
        done(err)
      })
    })

    it('should reject with exitcode WRONG_NPM_VER if global npm is the target and has wrong version', function(done) {
      const oldTgtVersion = mock.constants.targetVersion
      mock.constants.targetVersion = '999.999.999'
      shared.expectCorrectNpmVersion().then(() => {
        throw getDidNotReject()
      })
      .catch(err => {
        mock.constants.targetVersion = oldTgtVersion
        expect(err.exitcode).to.equal(ERRS.WRONG_NPM_VER)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject with exitcode NO_NPM for specified target with no package.json', function(done) {
      // At this point, mockNpmTarget path exists, and it has a
      // lib subdirectory, but no package.json
      shared.expectCorrectNpmVersion(mockNpmTarget)
      .then(() => done(getDidNotReject()))
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.NO_NPM)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject with exitcode NO_NPM for specified target with wrong name in package.json', function(done) {
      writeFileAsync(
        path.join(mockNpmTarget, 'package.json'),
        JSON.stringify({
          name: 'this-is-not-npm',
          version: `${EXPECTED_NPM_VER}`
        })
      )
      .then(() => shared.expectCorrectNpmVersion(mockNpmTarget))
      .then(() => done(getDidNotReject()))
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.NO_NPM)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject with exitcode BAD_NPM_INST for specified target with corrupted package.json', function(done) {
      writeFileAsync(
        path.join(mockNpmTarget, 'package.json'),
        `{\n  "name": "npm",\n  garbage from here on...\n\n`
      )
      .then(() => shared.expectCorrectNpmVersion(mockNpmTarget))
      .then(() => done(getDidNotReject()))
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.BAD_NPM_INST)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject with exitcode WRONG_NPM_VER for specified target with wrong version', function(done) {
      copyFileAsync(
        path.join(__dirname, 'fixtures', 'npm-wrong-version-package.json'),
        path.join(mockNpmTarget, 'package.json')
      )
      .then(() => shared.expectCorrectNpmVersion(mockNpmTarget))
      .then(() => done(getDidNotReject()))
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.WRONG_NPM_VER)
        done()
      })
      .catch(err => done(err))
    })

    it('should not reject for specified target with matching version', function(done) {
      copyFileAsync(
        path.join(__dirname, 'fixtures', 'mock-npm', 'package.json'),
        path.join(mockNpmTarget, 'package.json')
      )
      .then(() => shared.expectCorrectNpmVersion(mockNpmTarget))
      .then(() => done())
      .catch(err => done(err))
    })
  })

  describe('`removeAddedItems` function', function() {
    const messages = []
    const startDir = process.cwd()

    before('setup for all `removeAddedItems` tests', function() {
      shared.emitter.on('msg', (msg) => messages.push(msg))
      process.chdir(path.join(mockNpmTarget, 'lib'))
    })

    afterEach('per-item teardown', function() {
      messages.splice(0, messages.length)
    })

    after('teardown after all `removeAddedItems` tests', function() {
      shared.emitter.removeAllListeners()
      process.chdir(startDir)
    })

    it('should not reject if an expected script file to be removed is not present', function(done) {
      mock.ft.setErrorState('removeFiles', true, 'ENOENT')
      shared.removeAddedItems().then(() => {
        // Don't really need this, since the mock refuses to be put into
        // ENOENT error state, because actual fileTools never throws ENOENT;
        // but just for consistency here...
        mock.ft.setErrorState('removeFiles', false)
        // Emitter message would come from actual fileTools module, so
        // we don't test for that here
        done()
      })
      .catch(err => {
        mock.ft.setErrorState('removeFiles', false)
        done(err)
      })
    })

    it('should not reject if an added directory expected to be present is not found', function(done) {
      mock.ft.setErrorState('prune', true, 'ENOENT')
      shared.removeAddedItems().then(() => {
        mock.ft.setErrorState('prune', false)
        expect(messages[0]).to.match(/^Could not find directory/)
        done()
      })
      .catch(err => {
        mock.ft.setErrorState('prune', false)
        done(err)
      })
    })

    it('should reject if an added directory causes a problem other than ENOENT', function(done) {
      mock.ft.setErrorState('prune', true, 'EACCES')
      shared.removeAddedItems()
      .then(() => Promise.reject(getDidNotReject()))
      .catch(err => {
        mock.ft.setErrorState('prune', false)
        expect(err.exitcode).to.equal(ERRS.FS_ACTION_FAIL)
        expect(messages[0]).to.match(/^Unable to remove directory/)
        done()
      })
      .catch(err => done(err))
    })

    it('should not reject if all fileTools calls are successful', function(done) {
      shared.removeAddedItems().then(() => {
        expect(messages).to.be.empty
        done()
      })
      .catch(err => done(err))
    })
  })

  describe('`restoreBackups` function', function() {
    const messages = []

    before('setup for all `restoreBackups` tests', function() {
      shared.emitter.on('msg', (msg) => messages.push(msg))
    })

    afterEach('per-item teardown', function() {
      messages.splice(0, messages.length)
    })

    after('teardown after all `restoreBackups` tests', function() {
      shared.emitter.removeAllListeners()
    })

    // restoreBackups assumes that each path in TGTS.CHANGED_FILES is
    // specific enough to be reached from the current directory.
    // Actually, they are relative to npm/lib/, so we must chdir
    // before we call restoreBackups().

    it('should succeed if all expected backup files are present and accessible', function(done) {
      const startDir = process.cwd()
      rimrafAsync(mockNpmTarget)
      .then(() => testTools.copyFreshMockNpmDir(assetsRoot))
      .then(() => {
        process.chdir(path.join(mockNpmTarget, 'lib'))
        return makeMockBackups(0)
      })
      .then(() => shared.restoreBackups())
      .then(() => {
        process.chdir(startDir)
        expect(messages).to.be.empty
        done()
      })
      .catch(err => {
        process.chdir(startDir)
        done(err)
      })
    })

    it('should reject if any expected backup file is missing', function(done) {
      const startDir = process.cwd()
      process.chdir(path.join(mockNpmTarget, 'lib'))
      const targetFile = path.normalize(TGTS.CHANGED_FILES[0]) + BAKFLAG + '.js'
      makeMockBackups(0)
      .then(() => unlinkAsync(targetFile))
      .then(() => shared.restoreBackups())
      .then(() => Promise.reject(getDidNotReject()))
      .catch(err => {
        process.chdir(startDir)
        expect(err.exitcode).to.equal(ERRS.FS_ACTION_FAIL)
        expect(messages[0]).to.match(/^Unable to restore/)
        done()
      })
      .catch(err => done(err))
    })

    if (os.platform() != 'win32') {
      it('should reject if any expected backup file is inaccessible', function(done) {
        const startDir = process.cwd()
        process.chdir(path.join(mockNpmTarget, 'lib'))
        const targetFile = path.normalize(TGTS.CHANGED_FILES[0]) + BAKFLAG + '.js'
        // Assume we have the other backups in place from the previous test
        .then(() => writeFileAsync(targetFile, '', { mode: 0o000 }))
        .then(() => shared.restoreBackups())
        .then(() => Promise.reject(getDidNotReject()))
        .catch(err => {
          process.chdir(startDir)
          expect(err.exitcode).to.equal(ERRS.FS_ACTION_FAIL)
          expect(messages[0]).to.match(/^Unable to restore/)
          done()
        })
        .catch(err => done(err))
      })
    }
  })
})
