/*
offliner requires:
  download/dltracker
  download/git-aux
  git-offline
git-offline mock requires nothing but mock-dl-data.js.
*/
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const accessAsync = promisify(fs.access) // TEMP!

const expect = require('chai').expect
const npa = require('npm-package-arg')
const rimrafAsync = promisify(require('rimraf'))

const makeAssets = require('./lib/make-assets')

describe('offliner module', function() {
  const realSrcDir = path.resolve(__dirname, '../src')
  const mockSrcDir = path.join(__dirname, 'fixtures/self-mocks/src')
  const dummyFn = function(){}
  const testSpec = {}
  let assets
  let mockData
  let npf
  let npm
  let offliner

  function copyToTestDir(relPath, opts) {
    if (!opts) opts = {}
    const srcPath = path.join(opts.mock ? mockSrcDir : realSrcDir, relPath)
    const newFilePath = `${assets.npmLib}/${relPath}`
    const p = copyFileAsync(srcPath, path.resolve(__dirname, newFilePath))
    return opts.getModule ? p.then(() => require(newFilePath)) : p
  }

  before('set up test directory', function(done) {
    makeAssets('offliner', 'offliner.js', { mockDownloadDir: true })
    .then(result => {
      assets = result
      npm = require(`./${assets.npmLib}/npm`)
      // Helper for tests; no counterpart in actual installation
      return copyToTestDir('mock-dl-data.js', { mock: true, getModule: true })
    })
    .then(mod => {
      mockData = mod
      testSpec.byVersion = mockData.getSpec('version')
      testSpec.byRange = mockData.getSpec('range')
      testSpec.byTag = mockData.getSpec('tag')
      testSpec.remote = mockData.getSpec('remote')
      testSpec.git = mockData.getSpec('git')

      // makeAssets copies the entire mock download directory, which includes
      // mock npm-package-filename.js; but here we need the real thing
      return copyToTestDir('download/npm-package-filename.js', { getModule: true })
    })
    .then(mod => {
      npf = mod
      return copyToTestDir('git-offline.js', { mock: true })
    })
    .then(() => {
      offliner = require(`./${assets.npmLib}/offliner`)
      done()
    })
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    rimrafAsync(assets.fs('rootName')).then(() => done())
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

  it('should send back an error given a git repo spec unknown to the dlTracker', function(done) {
    offliner(npa('gitlab:myusr/myproj#semver:^5.0'), {}, function(err, newDep) {
      expect(err).to.be.an('error').that.matches(/knows nothing about/)
      done()
    })
  })

  describe('expected: npa parse result for a tarball spec if package is known by dlTracker', function() {
    it('should succeed given a non-git package spec', function(done) {
      const npaData = npa(testSpec.byVersion)
      const filename = mockData.getFilename(npaData)
      const npfData = npf.parse(filename)
      const dlData = {
        name: npaData.name,
        version: npfData.versionComparable,
        filename
      }
      npm.dlTracker.add('semver', dlData, function(err) {
        if (err) return done(err)
        const expectedPath = path.join(npm.dlTracker.path, filename)
        const expectedNpaObj = npa(expectedPath)
        offliner(npaData, {}, function(err, newDep) {
          if (err) return done(err)
          expect(newDep).to.deep.equal(expectedNpaObj)
          done()
        })
      })
    })

    it('should succeed given a git repo spec', function(done) {
      const npaData = npa(testSpec.git)
      const filename = mockData.getFilename(npaData)
      const npfData = npf.parse(filename)
      const dlData = {
        repo: npfData.repo,
        commit: npfData.commit,
        filename
      }
      npm.dlTracker.add('git', dlData, function(err) {
        if (err) return done(err)
        const expectedPath = path.join(npm.dlTracker.path, filename)
        const expectedNpaObj = npa(expectedPath)
        offliner(npaData, {}, function(err, newDep) {
          if (err) return done(err)
          expect(newDep).to.deep.equal(expectedNpaObj)
          done()
        })
      })
    })

    it('should succeed given spec for a git repo that was saved legacy-style (npm-two-stage v<=4)', function(done) {
      const legacyGitSpec = mockData.getSpec('git', 2)
      const npaData = npa(legacyGitSpec)
      const repoID = 'In the test case, repoID does not matter'
      npm.dlTracker.addLegacyGit(legacyGitSpec, repoID)
      const expectedPath = mockData.getFilename(npaData)
      const expectedNpaObj = npa(expectedPath)
      offliner(npaData, {}, function(err, newDep) {
        expect(newDep).to.deep.equal(expectedNpaObj)
        done()
      })
      .catch(err => done(err))
    })

  })
})
