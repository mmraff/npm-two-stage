const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const unlinkAsync = promisify(fs.unlink)
const writeFileAsync = promisify(fs.writeFile)

const expect = require('chai').expect
const rimrafAsync = promisify(require('rimraf'))

const { copyFreshMockNpmDir } = require('./lib/tools')

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

function setPrepareConfig(cfg) {
  const cfgPath = path.join(assets.root, 'npm', 'bin', 'cli-config.json')
  return cfg ?
    writeFileAsync(cfgPath, JSON.stringify(cfg)) : unlinkAsync(cfgPath)
}

function expectLogMessages(expected, spec) {
  const messages = mockNpmLog.messages()
  expect(messages).to.have.lengthOf(expected.length)
  expect(messages[0]).to.deep.equal({
    level: 'verbose',
    prefix: 'prepareGitDep',
    message: spec + ': installing devDeps and running prepare script.'
  })
  for (let i = 1; i < messages.length; ++i) {
    const wanted = expected[i]
    expect(messages[i].level).to.equal(wanted.level)
    expect(messages[i].prefix).to.equal('prepareGitDep')
    expect(messages[i].message).to.match(new RegExp(wanted.message))
  }
}

const failedToReject_msg = 'Should have rejected'
const dummySpec = 'test-dummy-spec'

let prepRawModule
let mockNpmLog

describe('prepare-raw-module', function() {
  before('set up test directory', function(done) {
    rimrafAsync(assets.root).then(() => mkdirAsync(assets.root))
    .then(() => copyFreshMockNpmDir(assets.root))
    .then(() => {
      //npm = require(path.join(assets.dest, 'npm'))
      mockNpmLog = require(path.join(assets.nodeMods, 'npmlog'))
      return copyToTestDir('prepare-raw-module.js', { getModule: true })
      .then(mod => prepRawModule = mod)
    })
    .then(() => done())
    .catch(err => done(err))
  })

  afterEach('in-between cleanup', function() {
    mockNpmLog.purge()
  })

  after('remove temporary assets', function(done) {
    rimrafAsync(assets.root).then(() => done())
    .catch(err => done(err))
  })

  it('should resolve but have no side effects if package has no "scripts" section', function(done) {
    prepRawModule({})
    .then(() => {
      expect(mockNpmLog.messages()).to.have.lengthOf(0)
      done()
    })
    .catch(err => done(err))
  })

  it('should resolve but have no side effects if package has no "prepare" script', function(done) {
    prepRawModule({ scripts: {} })
    .then(() => {
      expect(mockNpmLog.messages()).to.have.lengthOf(0)
      done()
    })
    .catch(err => done(err))
  })

  it('should log expected messages and resolve if package has a "prepare" script', function(done) {
    const cfgMsg = 'looks good so far'
    setPrepareConfig({ output: cfgMsg })
    .then(() => prepRawModule(
      { scripts: { prepare: 'echo Harmless output' } },
      // Discovery: MUST give an existing path for the next arg,
      // else there is a mysterious ENOENT error
      assets.root,
      // For the npa object, all that's needed is the 'raw' field
      { raw: dummySpec }
    ))
    .then(() => {
      expectLogMessages(
        [
          {}, // dummy - ignored - standard 1st message assumed here
          { level: 'silly', message: `^1> ${cfgMsg}` }
        ],
        dummySpec
      )
      done()
    })
    .catch(err => done(err))
  })

  it('should log expected messages and reject if "prepare" script causes a fatal error', function(done) {
    const goodMsg = 'looks good so far'
    const badMsg = 'OOPS OH NO'
    setPrepareConfig({ output: goodMsg, error: badMsg })
    .then(() => prepRawModule(
      { scripts: { prepare: 'echo Harmless output' } },
      assets.root,
      { raw: dummySpec }
    ))
    .then(() => { throw new Error(failedToReject_msg) })
    .catch(err => {
      expect(err).to.match(/npm exited [ \w\d]+ while attempting to build/)
      expect(err.code).to.equal(1)
      expect(err.signal).to.be.null
      expectLogMessages(
        [
          {}, // dummy - ignored - standard 1st message assumed here
          { level: 'error', message: `^1> ${goodMsg}` },
          { level: 'error', message: `^2> [\\w\\W]+ ${badMsg}` }
          // [\w\W] instead of . so that newline chars are included
        ],
        dummySpec
      )
      done()
    })
    .catch(err => done(err))
  })

  it('should log expected messages and resolve if "prepare" script has stderr output but no abort', function(done) {
    const errMsg = 'early warnings'
    setPrepareConfig({ stderr: errMsg })
    .then(() => prepRawModule(
      { scripts: { prepare: 'echo Harmless output' } },
      assets.root,
      { raw: dummySpec }
    ))
    .then(() => {
      expectLogMessages(
        [
          {}, // dummy - ignored - standard 1st message assumed here
          { level: 'silly', message: `^2> ${errMsg}` }
        ],
        dummySpec
      )
      done()
    })
    .catch(err => done(err))
  })

  it('"prepare" script causes a fatal error, but no stdio output', function(done) {
    const errMsg = 'flu symptoms'
    setPrepareConfig({
      error: errMsg
    })
    .then(() => prepRawModule(
      { scripts: { prepare: 'echo Harmless output' } },
      assets.root,
      { raw: dummySpec }
    ))
    .then(() => { throw new Error(failedToReject_msg) })
    .catch(err => {
      expect(err).to.match(/npm exited [ \w\d]+ while attempting to build/)
      expect(err.code).to.equal(1)
      expect(err.signal).to.be.null
      expectLogMessages(
        [
          {}, // dummy - ignored - standard 1st message assumed here
          { level: 'error', message: `^2> [\\w\\W]+ ${errMsg}` }
          // [\w\W] instead of . so that newline chars are included
        ],
        dummySpec
      )
      done()
    })
    .catch(err => done(err))
  })
})
