const Emitter = require('events')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const renameAsync = promisify(fs.rename)
const unlinkAsync = promisify(fs.unlink)

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
assets.wrongDir = path.join(assets.root, 'not-npm')
assets.npmDir = path.join(assets.root, 'npm')
assets.installDest = path.join(assets.npmDir, 'lib')
assets.n2sMockLibPath = path.join(assets.root, 'lib')

const mock = {}
const realSrcDir = path.resolve(__dirname, '..', 'src')

const msgPatterns = [
  /^Checking npm version/,
  {
    failure: /^Wrong version of npm/,
    success: /^Target npm home is/
  },
  {
    all: /^All backups/,
    none: /^No backups/,
    some: /^Incomplete set of backups/
  },
  {
    none: /^No standard files missing/,
    some: /^Some standard files are missing/
  },
  {
    all: /^All expected new files/,
    none: /^No new files present/,
    some: /^Some expected new files/
  },
  { // Summary line
    full: /fully installed/,
    not: /not installed/,
    partial: /^Incomplete/,
    bad: /^Files expected .+ are missing/
  }
]

function expectStandardMessages(msgList, size, hints) {
  expect(msgList).have.lengthOf(size)
  expect(msgList[0]).to.match(msgPatterns[0])
  for (let msgIdx = 1, hintIdx = 1; msgIdx < size; ++msgIdx, ++hintIdx) {
    expect(msgList[msgIdx]).to.match(msgPatterns[hintIdx][hints[hintIdx]])
    if (hints[hintIdx] == 'some') {
      expect(msgList[++msgIdx]).to.match(/^Missing:/)
    }
  }
}

// This is almost the same as backUpOldFiles() in install.js.
// As there, we must be in npm/lib/.
function makeBackups(i) {
  if (i >= TGTS.CHANGED_FILES.length) return Promise.resolve()
  const oldName = TGTS.CHANGED_FILES[i]
  // Must use path.normalize() because any of the given items may contain
  // posix path separators (e.g. 'util/cmd-list'):
  const backupName = path.normalize(`${oldName}${BAKFLAG}.js`)
  return renameAsync(path.normalize(oldName + '.js'), backupName)
  .then(() => makeBackups(i+1))
}

function copySrcFilesHere() { // Here too, we must be in npm/lib/.
  const files = TGTS.CHANGED_FILES.concat(TGTS.ADDED_FILES)
    .map(f => path.normalize(f + '.js'))
  const srcFiles = files.map(f => path.join(realSrcDir, f))

  function nextFile(i) {
    if (i >= files.length) return Promise.resolve()
    return copyFileAsync(srcFiles[i], files[i])
    .then(() => nextFile(i+1))
  }
  return nextFile(0)
}

function copySrcDirsHere() { // ditto
  const dirList = TGTS.ADDED_DIRS.map(d => path.join(realSrcDir, d))
  function nextDir(i) {
    if (i >= dirList.length) return Promise.resolve()
    return graft(dirList[i], '.')
    .then(() => nextDir(i+1))
  }
  return nextDir(0)
}



function getDidNotReject() {
  return new Error('Failed to get expected rejection')
}

describe('`status` module', function() {
  let targetMod // The target module, status.js

  before('set up test directory', function(done) {
    const fixtureLibPath = path.join(__dirname, 'fixtures', 'self-mocks', 'lib')
    const targetModPath = path.join(assets.n2sMockLibPath, 'status.js')
    rimrafAsync(assets.root).then(() => mkdirAsync(assets.root))
    .then(() => graft(fixtureLibPath, assets.root))
    .then(() => copyFileAsync(
      path.join(__dirname, '..', 'lib', 'status.js'), targetModPath
    ))
    .then(() => {
      mock.shared = require(path.join(assets.n2sMockLibPath, 'shared.js'))
      targetMod = require(targetModPath)
    })
    .then(() => mkdirAsync(assets.wrongDir))
    .then(() => testTools.copyFreshMockNpmDir(assets.root))
    .then(() => done())
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    rimrafAsync(assets.root).then(() => done())
    .catch(err => done(err))
  })

  it('should export an emitter named `statusProgress`', function() {
    expect(targetMod).to.have.property('statusProgress')
    .that.is.an.instanceof(Emitter)
  })

  it('should export a function named `getStatus`', function() {
    expect(targetMod).to.have.property('getStatus').that.is.a('function')
  })

  describe('`getStatus` function', function() {
    const messages = []

    before('setup for all `getStatus` tests', function() {
      targetMod.statusProgress.on('msg', (msg) => messages.push(msg))
    })

    afterEach('per-item teardown', function() {
      messages.splice(0, messages.length)
    })

    after('teardown after all `getStatus` tests', function() {
      targetMod.statusProgress.removeAllListeners()
    })

    it('should reject if checking the npm version at the target gets a rejection', function(done) {
      mock.shared.setErrorState('expectCorrectNpmVersion', true, 'ENOENT')
      targetMod.getStatus(path.join(assets.root, 'NOSUCHDIR'))
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        mock.shared.setErrorState('expectCorrectNpmVersion', false)
        expect(err.code).to.equal('ENOENT')
        expectStandardMessages(messages, 1)
        done()
      })
      .catch(err => done(err))
    })

    it('should reject if target npm installation has wrong version', function(done) {
      mock.shared.setErrorState(
        'expectCorrectNpmVersion', true, undefined, ERRS.WRONG_NPM_VER
      )
      targetMod.getStatus().then(() => { throw getDidNotReject() })
      .catch(err => {
        mock.shared.setErrorState('expectCorrectNpmVersion', false)
        expectStandardMessages(messages, 2, [null, 'failure'])
        done()
      })
      .catch(err => done(err))
    })

    it('should not reject if global npm is the target and has correct version', function(done) {
      // This is only for coverage.
      // We can get away with the following regardless of the version of the
      // actual global npm, because we're mocking expectCorrectNpmVersion
      targetMod.getStatus().then(() => done())
      .catch(err => done(err))
    })

    it('should reject if base directory "lib" is missing from npm installation at given path', function(done) {
      copyFileAsync(
        path.join(assets.npmDir, 'package.json'),
        path.join(assets.wrongDir, 'package.json')
      )
      // Here there's a package.json to check, but not a lib dir to chdir into
      .then(() => targetMod.getStatus(assets.wrongDir))
      .then(() => { throw getDidNotReject() })
      .catch(err => {
        expect(err.exitcode).to.equal(ERRS.BAD_NPM_INST)
        expectStandardMessages(messages, 2, [ null, 'success' ])
        done()
      })
      .catch(err => done(err))
    })

    it('should emit appropriate messages when the target is not a complete npm installation', function(done) {
      // Pick up where we left off with the incomplete mock npm installation
      mkdirAsync(path.join(assets.wrongDir, 'lib'))
      // Now at least getStatus() can chdir into lib...
      .then(() => targetMod.getStatus(assets.wrongDir))
      .then(() => {
        expectStandardMessages(messages, 7, [ null, 'success', 'none', 'some', 'none', 'bad' ])
        done()
      })
      .catch(err => done(err))
    })

    it('should emit appropriate messages when the target is a fresh complete npm installation', function(done) {
      targetMod.getStatus(assets.npmDir)
      .then(() => {
        expectStandardMessages(messages, 6, [ null, 'success', 'none', 'none', 'none', 'not' ])
        done()
      })
      .catch(err => done(err))
    })

    it('should emit appropriate messages when the target has npm-two-stage installed', function(done) {
      const startDir = process.cwd()
      process.chdir(assets.installDest)
      makeBackups(0)
      .then(() => copySrcFilesHere())
      .then(() => copySrcDirsHere())
      .then(() => {
        process.chdir(startDir)
        return targetMod.getStatus(assets.npmDir)
      })
      .then(() => {
        expectStandardMessages(messages, 6, [ null, 'success', 'all', 'none', 'all', 'full' ])
        done()
      })
      .catch(err => {
        process.chdir(startDir) // Just in case
        done(err)
      })
    })

    it('should emit appropriate messages when the modified target is missing a backup file', function(done) {
      const choice = TGTS.CHANGED_FILES[TGTS.CHANGED_FILES.length - 1]
      const choicePath = path.join(assets.installDest, `${choice}${BAKFLAG}.js`)
      unlinkAsync(choicePath)
      .then(() => targetMod.getStatus(assets.npmDir))
      .then(() => {
        expectStandardMessages(messages, 7, [ null, 'success', 'some', 'none', 'all', 'partial' ])
        done()
      })
      .catch(err => done(err))
    })

    it('should emit appropriate messages when the modified target is missing a file added by npm2stage', function(done) {
      const choice = TGTS.ADDED_FILES[TGTS.ADDED_FILES.length - 1]
      const choicePath = path.join(assets.installDest, choice + '.js')
      unlinkAsync(choicePath)
      .then(() => targetMod.getStatus(assets.npmDir))
      .then(() => {
        expectStandardMessages(messages, 8, [ null, 'success', 'some', 'none', 'some', 'partial' ])
        done()
      })
      .catch(err => done(err))
    })
  })
})
