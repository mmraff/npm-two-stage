/*
  TODO:
  * Use a non-mocked dltracker, and npm-package-filename,
    because those are already fully unit-tested as independent packages.
    This test suite will function as a test of integration with them.
  * dltracker requires graceful-fs (npm@6 uses 4.2.3), so we'll need to install that;
    thankfully, no dependencies.
  * also requires semver (npm@6 uses 5.7.1), but that's already present as a
    result of devDependencies (e.g., npm-package-arg).
  * Instantiate the dlTracker and set it on the npm object.
  * The dlTracker will only be usable if we have some (mock) tarballs to add to it.

  * Figure out if it makes sense to mock git-aux.
*/

const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const writeFileAsync = promisify(fs.writeFile)

const expect = require('chai').expect
const npa = require('npm-package-arg')

const ft = require('../lib/file-tools')
const { copyFreshMockNpmDir } = require('./lib/tools')
let offliner  // We will require() the dynamically-placed copy
let npm       // ditto
let DlTracker // ditto
let addAsync  // ditto
let mockData  // ditto
let npf       // ditto
const testSpec = {}

const assets = {
  root: path.join(__dirname, 'tempAssets')
}
assets.dest = path.join(assets.root, 'npm', 'lib')
assets.trackerDir = path.join(assets.root, 'tarballs')
const realSrcDir = path.join(__dirname, '..', 'src')
const selfMocksDir = path.join(__dirname, 'fixtures', 'self-mocks')

const dummyFn = function(){}

function copyToTestDir(relPath, opts) {
  if (!opts) opts = {}
  const srcPath = path.join(opts.mock ? selfMocksDir : realSrcDir, relPath)
  const newFilePath = path.join(assets.dest, relPath)
  const p = copyFileAsync(srcPath, newFilePath)
  return opts.getModule ? p.then(() => require(newFilePath)) : p
}

describe('offliner module', function() {
  before('set up test directory', function(done) {
    ft.prune(assets.root)
    .catch(err => { if (err.code != 'ENOENT') throw err })
    .then(() => mkdirAsync(assets.root))
    .then(() => copyFreshMockNpmDir(assets.root))
    .then(() => npm = require(path.join(assets.dest, 'npm')))
    .then(() => mkdirAsync(assets.trackerDir))
    .then(() =>
      // Helper for tests; no counterpart in actual installation
      copyToTestDir('mock-dl-data.js', { mock: true, getModule: true })
      .then(mod => {
        mockData = mod
        testSpec.version = mockData.getSpec('version')
      })
    )
    .then(() => // The real thing from our src directory
      ft.graft(path.join(realSrcDir, 'download'), assets.dest)
    )
    .then(() => {
      npf = require(path.join(assets.dest, 'download', 'npm-package-filename'))
      DlTracker = require(path.join(assets.dest, 'download', 'dltracker'))
      return promisify(DlTracker.create)(assets.trackerDir)
    })
    .then(tracker => {
      addAsync = promisify(tracker.add)
      npm.dlTracker = tracker
    })
    .then(() => {
// TODO: I suspect that this sequence will get used more than once, and will justify an aux function.
      const filename = mockData.getFilename(npa(testSpec.version))
      const npfData = npf.parse(filename)
      const pkgData = {
        name: npfData.packageName,
        version: npfData.versionComparable,
        filename: filename
      }
      const tarballPath = path.join(assets.trackerDir, filename)
      return writeFileAsync(tarballPath, 'DUMMY TEXT')
      .then(() => addAsync(npfData.type, pkgData))
    })
    // Mock:
    .then(() =>
      copyToTestDir(path.join('download', 'git-aux.js'), { mock: true })
    )
    // Mock:
    .then(() => copyToTestDir('git-offline.js', { mock: true }))
    // Real thing:
    .then(() =>
      copyToTestDir('offliner.js', { getModule: true })
      .then(mod => offliner = mod)
    )
    .then(() => done())
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    ft.prune(assets.root).then(() => done())
    .catch(err => done(err))
  })

  it('should throw for missing or wrong type arguments', function() {
    const nothings = [ undefined, null ]
    const nonObjects = [ true, 42, 'hello', dummyFn ]
    const nonFunctions = [ true, 42, 'hello', [], {} ]
    const notNpaResults = [ [], {}, { type: null }, { type: 42 }, new Date() ]
    const npaGoodResult = npa('dummy-pkg@1.2.3')

    expect(function(){ offliner() }).to.throw(SyntaxError)

    for (let i = 0; i < nothings.length; ++i)
      expect(function(){ offliner(nothings[i], {}, dummyFn) }).to.throw(SyntaxError)
    for (let i = 0; i < nonObjects.length; ++i)
      expect(function(){ offliner(nonObjects[i], {}, dummyFn) }).to.throw(TypeError)
    for (let i = 0; i < notNpaResults.length; ++i)
      expect(function(){ offliner(notNpaResults[i], {}, dummyFn) }).to.throw(TypeError)

    for (let i = 0; i < nothings.length; ++i)
      expect(function(){ offliner(npaGoodResult, nothings[i], dummyFn) }).to.not.throw()
    for (let i = 0; i < nonObjects.length; ++i)
      expect(function(){ offliner(npaGoodResult, nonObjects[i], dummyFn) }).to.throw(TypeError)

    expect(function(){ offliner(npaGoodResult, {}) }).to.throw(SyntaxError)
    for (let i = 0; i < nothings.length; ++i)
      expect(function(){ offliner(npaGoodResult, {}, nothings[i]) }).to.throw(SyntaxError)
    for (let i = 0; i < nonFunctions.length; ++i)
      expect(function(){ offliner(npaGoodResult, {}, nonFunctions[i]) }).to.throw(TypeError)
  })

  it('should send back an error for npa spec with unhandled type', function(done) {
    const unhandledDeps = [
      path.resolve('road/to/nowhere'),
      'local-tarball-0.0.0.tgz',
      'myAlias@npm:myName'
    ]
    function iterateUnhandledDeps(i, next) {
      if (i >= unhandledDeps.length) return next()
      const dep = npa(unhandledDeps[i])
      try {
        offliner(dep, {}, function(err, newDep) {
          try { expect(err).to.be.an('error').that.matches(/unhandled/) }
          catch (unexpected) { return next(unexpected) }
          iterateUnhandledDeps(i+1, next)
        })
      }
      catch (err) { next(err) }
    }
    iterateUnhandledDeps(0, function(err) {
      if (err) return done(err)
      const dep = npa('dummy-pkg@1.2.3')
      dep.type = 'garbage'
      try {
        offliner(dep, {}, function(err, newDep) {
          try { expect(err).to.be.an('error').that.matches(/unhandled/) }
          catch (unexpected) { return done(unexpected) }
          done()
        })
      }
      catch (err) { done(err) }
    })
  })

  it('should send back an error for a bad npa spec, even if of handled type', function(done) {
    const badDep = npa('')
    offliner(badDep, {}, function(err, newDep) {
      try { expect(err).to.be.an('error').that.matches(/knows nothing/) }
      catch (unexpected) { return done(unexpected) }
      done()
    })
  })

  it('should send back an error if package is reported unknown by dlTracker', function(done) {
    const unknownDep = npa('unknown@9.9.9')
    offliner(unknownDep, {}, function(err, newDep) {
      try { expect(err).to.be.an('error').that.matches(/knows nothing/) }
      catch (unexpected) { return done(unexpected) }
      done()
    })
  })

  it('should send back the expected npa parse result for a tarball if package is known by dlTracker', function(done) {
    const filename = mockData.getFilename(npa(testSpec.version))
    const expectedPath = path.join(npm.dlTracker.path, filename)
    const expectedNpaObj = npa(expectedPath)
    offliner(npa(testSpec.version), {}, function(err, newDep) {
      expect(newDep).to.deep.equal(expectedNpaObj)
      done()
    })
  })
  /*
    TODO (not here, but in git-aux_test.js):
    * git-aux requires
      - npm-pick-manifest, which requires goddamn figgy-pudding (which has no deps, at least)
      - pacote/lib/util/git, which might be tricky to mock, but even worse to make pacote a devDep, so...
  */
})
