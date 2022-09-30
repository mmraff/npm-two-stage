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

const assetsRootName = 'n2s_install'
const assets = {
  root: path.join(__dirname, assetsRootName),
  get emptyDir () { return path.join(this.root, 'EMPTY_DIR') },
  get wrongDir () { return path.join(this.root, 'not-npm') },
  get npmDir () { return path.join(this.root, 'npm') },
  get installDest () { return path.join(this.root, 'npm/lib') },
  get n2sMockSrcPath () { return path.join(this.root, 'src') }
}

const mock = {}
const realSrcDir = path.resolve(__dirname, '../src')
const wrongVersionPJFile = path.join(
  __dirname, 'fixtures/npm-wrong-version-package.json'
)

const msgPatterns = [
  /^Checking npm version/,
  /^Target npm home is/,
  /^Backing up files to be replaced:/,
  /^Copying into target directory:/   // just before chdir(src)
]

function expectStandardMessages(msgList, size) {
  expect(msgList).have.lengthOf.at.least(size)
  for (let i = 0; i < size; ++i)
    expect(msgList[i]).to.match(msgPatterns[i])
}

function getDidNotReject() {
  return new Error('Failed to get expected rejection')
}

describe('`install` module', function() {
  let n2sInstaller // The target module

  before('set up test directory', function(done) {
    const fixtureLibPath = path.join(__dirname, 'fixtures/self-mocks/lib')
    const mockN2sLibPath = path.join(assets.root, 'lib')
    const mocksRequirePrefix = `./${assetsRootName}/lib/`

    rimrafAsync(assets.root).then(() => mkdirAsync(assets.root))
    .then(() => graft(realSrcDir, assets.root))
    .then(() => graft(fixtureLibPath, assets.root))
    .then(() => copyFileAsync(
      path.resolve(__dirname, '../lib/install.js'),
      path.join(mockN2sLibPath, 'install.js')
    ))
    .then(() => {
      mock.constants = require(mocksRequirePrefix + 'constants.js')
      mock.ft = require(mocksRequirePrefix + 'file-tools.js')
      mock.shared = require(mocksRequirePrefix + 'shared.js')
      n2sInstaller = require(mocksRequirePrefix + 'install.js')
    })
    .then(() => mkdirAsync(assets.emptyDir))
    .then(() => mkdirAsync(assets.wrongDir))
    .then(() => copyFileAsync(
      path.join(__dirname, 'fixtures/dummy/package.json'),
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

  it('should export an emitter named `installProgress`', function() {
    expect(n2sInstaller).to.have.property('installProgress').that.is.an.instanceof(Emitter)
  })

  it('should export a function named `install`', function() {
    expect(n2sInstaller).to.have.property('install').that.is.a('function')
  })

  describe('`install` function', function() {
    const messages = []

    before('setup for all `install` tests', function() {
      n2sInstaller.installProgress.on('msg', (msg) => messages.push(msg))
    })

    afterEach('per-item teardown', function() {
      messages.splice(0, messages.length)
    })

    after('teardown after all `install` tests', function() {
      n2sInstaller.installProgress.removeAllListeners()
    })

    it('should reject if checking the npm version at the target gets a rejection', function(done) {
      mock.shared.setErrorState('expectCorrectNpmVersion', true, 'ENOENT')
      n2sInstaller.install(path.join(assets.root, 'NOSUCHDIR'))
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
      This is risky, because in the (unlikely) event that the install code is wrong,
      and the running process just happens to have admin privileges, the call could
      succeed, and unintentionally contaminate the live npm on the test system.
    */
    it('should reject if global npm is the target and has wrong version', function(done) {
      mock.shared.setErrorState('expectCorrectNpmVersion', true)
      n2sInstaller.install().then(() => { throw getDidNotReject() })
      .catch(err => {
        mock.shared.setErrorState('expectCorrectNpmVersion', false)
        expectStandardMessages(messages, 1)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if dirs/files of interest are missing from npm installation at given path', function(done) {
      // Derive the subdirectories that must previously exist in npm/lib
      // for a npm-two-stage installation to proceed, because they will
      // not exist yet in our dummy directory
      const existingDirs = TGTS.CHANGED_FILES.filter(f => f.includes('/'))
        .map(f => path.dirname(path.normalize(f)))

      function createRequiredLibDirs(i, where) {
        if (i >= existingDirs.length) return Promise.resolve()
        return mkdirpAsync(path.join(where, existingDirs[i]))
        .then(() => createRequiredLibDirs(i+1, where))
      }

      const tempLibPath = path.join(assets.wrongDir, 'lib')
      copyFileAsync(
        path.join(assets.npmDir, 'package.json'),
        path.join(assets.wrongDir, 'package.json')
      )
      // Here there's a package.json to check, but not a lib dir to chdir into
      .then(() => n2sInstaller.install(assets.wrongDir))
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.BAD_NPM_INST)
        expectStandardMessages(messages, 2)
        messages.splice(0, messages.length) // clear it for the following test
      })
      .then(() => mkdirAsync(tempLibPath))
      // Now at least install() can chdir into lib...
      .then(() => n2sInstaller.install(assets.wrongDir))
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.BAD_NPM_INST)
        expectStandardMessages(messages, 2)
        messages.splice(0, messages.length) // clear it for the following test
      })
      .then(() => createRequiredLibDirs(0, tempLibPath))
      // But we're still missing js files
      .then(() => n2sInstaller.install(assets.wrongDir))
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.BAD_NPM_INST)
        expectStandardMessages(messages, 3)
        messages.splice(0, messages.length) // clear it for the following test
      })
      .then(() => {
        // Put the 1st expected file into place, so that it will get renamed
        // to a backup, then the next expected file will be missing; in this
        // way, not only do we get a BAD_NPM_INST exitcode, but restoreOldFiles
        // is triggered (we need this for coverage)
        const expectedFile = TGTS.CHANGED_FILES[0] + '.js'
        const expectedPath = path.join(tempLibPath, expectedFile)
        return writeFileAsync(expectedPath, 'zzz')
        .then(() => n2sInstaller.install(assets.wrongDir))
      })
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.BAD_NPM_INST)
        expectStandardMessages(messages, 3)
        done()
      })
      .catch(err => done(err))
    })

    it ('should reject if any previously added npm-two-stage files are present', function(done) {
      const topNewFiles = TGTS.ADDED_FILES.filter(f => !f.includes('/'))
      // A 'deep new file' is a file added from npm-two-stage to a subdirectory of npm/lib.
      // In the current version (6.13.4), there are none such; but this test case stays
      // for future versions when they may exist.
      const deepNewFiles = TGTS.ADDED_FILES.filter(f => f.includes('/'))

      rimrafAsync(assets.npmDir)
      .then(() => testTools.copyFreshMockNpmDir(assets.root))
      .then(() => {
        const leftover = path.join(assets.npmDir, 'lib', topNewFiles[0] + '.js')
        return writeFileAsync(leftover, 'zzz')
        .then(() => n2sInstaller.install(assets.npmDir))
        .then(() => { throw getDidNotReject() })
        .catch(err => {
          expect(err.exitcode).to.equal(ERRS.LEFTOVERS)
          expectStandardMessages(messages, 2)
          return unlinkAsync(leftover)
        })
      })
      .then(() => deepNewFiles.length ?
        writeFileAsync(path.join(assets.npmDir, 'lib', deepNewFiles[0] + '.js'), 'zzz')
        .then(() => n2sInstaller.install(assets.npmDir))
        .then(() => { throw getDidNotReject() })
        .catch(err => {
          expect(err.exitcode).to.equal(ERRS.LEFTOVERS)
          expectStandardMessages(messages, 2)
        })
        : null
      )
      .then(() => done())
      .catch(err => done(err))
    })

    it ('should reject if any backup files are present', function(done) {
      rimrafAsync(assets.npmDir)
      .then(() => testTools.copyFreshMockNpmDir(assets.root))
      .then(() => {
        const unexpectedFile = TGTS.CHANGED_FILES[0] + BAKFLAG + '.js'
        const unexpectedPath = path.join(assets.npmDir, 'lib', unexpectedFile)
        return writeFileAsync(unexpectedPath, 'zzz')
        .then(() => n2sInstaller.install(assets.npmDir))
      })
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.LEFTOVERS)
        expectStandardMessages(messages, 2)
        done()
      })
      .catch(err => done(err))
    })

    it ('should reject if any of the npm-two-stage source is unavailable', function(done) {
      rimrafAsync(assets.npmDir)
      .then(() => testTools.copyFreshMockNpmDir(assets.root))
      .then(() => {
        const newSrcDirPath = path.join(path.dirname(assets.n2sMockSrcPath), 'RENAMED_SRC')
        return renameAsync(assets.n2sMockSrcPath, newSrcDirPath)
        .then(() => n2sInstaller.install(assets.npmDir))
        .then(() => { throw getDidNotReject() })
        .catch(err =>
          renameAsync(newSrcDirPath, assets.n2sMockSrcPath)
          /*
            Need to do the following teardown/rebuild because, while install
            does cleanup if the error happens after changes have already been
            made, it hands off some of the cleanup to an external function
            (restoreBackups in shared.js) which we have stubbed in the mock.
          */
          .then(() => rimrafAsync(assets.npmDir))
          .then(() => testTools.copyFreshMockNpmDir(assets.root))
          /* End of mock remediation */
          .then(() => {
            expect(err.exitcode).to.equal(ERRS.BAD_PROJECT)
            expectStandardMessages(messages, 4)
          })
        )
      })
      .then(() => {
        const lastIndex = TGTS.ADDED_FILES.length - 1
        if (lastIndex < 0) return // Really unlikely ever, but just in case
        const targetFilename = TGTS.ADDED_FILES[lastIndex]
        const origFilepath = path.join(assets.n2sMockSrcPath, targetFilename + '.js')
        const newFilepath = path.join(assets.n2sMockSrcPath, `RENAMED_${targetFilename}.js`)
        return renameAsync(origFilepath, newFilepath)
        .then(() => n2sInstaller.install(assets.npmDir))
        .then(() => { throw getDidNotReject() })
        .catch(err =>
          renameAsync(newFilepath, origFilepath)
          .then(() => {
            expect(err.exitcode).to.equal(ERRS.BAD_PROJECT)
            expectStandardMessages(messages, 4)
          })
        )
      })
      .then(() => done())
      .catch(err => done(err))
    })

    it ('should succeed if the target is accessible and looks enough like a proper npm installation', function(done) {
      rimrafAsync(assets.npmDir)
      .then(() => testTools.copyFreshMockNpmDir(assets.root))
      .then(() => n2sInstaller.install(assets.npmDir))
      // We must not try to verify an actual successful installation,
      // because install uses fileTools.graft() to copy directories
      // (e.g., src/download), but fileTools is mocked here.
      .then(() => done())
      .catch(err => {
        done(err)
      })
    })

    it ('should reject if npm-two-stage is already installed at the target', function(done) {
      // TODO: This is going to be redundant for the unit test, but good to keep in the integration test.
      n2sInstaller.install(assets.npmDir)
      .then(() => done(getDidNotReject()))
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.LEFTOVERS)
        expectStandardMessages(messages, 2)
        done()
      })
      .catch(err => done(err))
    })
  })
})
