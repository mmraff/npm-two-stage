/*
  TODO
  * Other things that fpm raises an error for:
    - offliner sends back an error
    - theoretically, any of those things in the pacote.manifest reject handler

  * When (!isOffline), check that result is the same as for unmodified npm -
    that is to say, the _requested field is (likely to be) an npa result object
    where the field values match the corresponding values in the manifest.

  * Use tap for a *later* version of this.
    tap@latest (16.0.1 at this time) requires nodejs >= 12
    (even tap@13 has dependencies that require nodejs 10, despite what the
    "engines" section says in the tap@13 package.json)

  * When offliner_test is run after this suite, it fails several tests. ???
    Workaround in place: use number prefixes to force a certain order.
    But the 2 suites should be independent, and so unaffected by order...
    Find out what the hitch is.
    *** I KNOW WHAT IT IS *****************************************
    Despite the fact that we tear down the mock npm installation at the end
    of one test, then recreate it and re-require modules,
    WE ARE STILL IN THE SAME NODE.JS SESSION, SO THE MODULE STATES ARE RETAINED!
    This will affect the tests negatively wherever we have a mock module for
    one test and the real thing for another. !!!!!! SUPER-SUCK!!!!!!!!!!!!!!!
*/
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const rmdirAsync = promisify(fs.rmdir)
const unlinkAsync = promisify(fs.unlink)

const expect = require('chai').expect
const npa = require('npm-package-arg')

const ft = require('../lib/file-tools')
const { copyFreshMockNpmDir } = require('./lib/tools')
let fetchPkgMetadata // We will require() the dynamically-placed copy
let mockData // ditto
let npm // ditto
let pacote // ditto

const testSpec = {}

const assets = {
  root: path.join(__dirname, 'tempAssets')
}
const dummyFn = function(){}

describe('fetch-package-metadata replacement module', function() {
  before('set up test directory', function(done) {
    ft.prune(assets.root)
    .catch(err => { if (err.code != 'ENOENT') throw err })
    .then(() => mkdirAsync(assets.root))
    .then(() => copyFreshMockNpmDir(assets.root))
    .then(() => {
      const destPath = path.join(assets.root, 'npm', 'lib')
      // We get this so that we can toggle offline mode:
      npm = require(path.join(destPath, 'npm'))
      // We get this so that we can make some packages appear to be available
      // and prevent mock-pacote.manifest from erroring:
      pacote = require(path.join(assets.root, 'npm', 'node_modules', 'pacote'))

      const selfMocksPath = path.join(__dirname, 'fixtures', 'self-mocks')
      const filename = 'offliner.js'
      return copyFileAsync( // Mock
        path.join(selfMocksPath, filename), path.join(destPath, filename)
      )
      .then(() => { // Helper for tests; no counterpart in actual installation
        const filename = 'mock-dl-data.js'
        const newFilePath = path.join(destPath, filename)
        return copyFileAsync(
          path.join(selfMocksPath, filename), newFilePath
        )
        .then(() => {
          mockData = require(newFilePath)
          testSpec.version = mockData.getSpec('version')
          pacote.addTestSpec(testSpec.version)
        })
      })
      .then(() => { // The real thing from our src directory
        const filename = 'fetch-package-metadata.js'
        const srcFilePath = path.join(__dirname, '..', 'src', filename)
        const newFilePath = path.join(destPath, filename)
        return copyFileAsync(srcFilePath, newFilePath)
        .then(() => fetchPkgMetadata = require(newFilePath))
      })
    })
    .then(() => done())
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    ft.prune(assets.root).then(() => done())
    .catch(err => done(err))
  })

  // Unfortunately, the function becomes untestable when not given any args,
  // or when there's no callback in the 3rd or 4th arg position (including
  // the case where the callback arg is not a function); this is because
  // of the call-limit wrap, which relies on the callback.

  const notStringArgs = [ undefined, null, 42, true, {}, [], dummyFn ]
  const notOptsOrFn = [ undefined, null, 42, true, 'hello', [], dummyFn ]
  const where = '.'

  it('should pass back an error if `spec` argument is not a string or object', function(done) {
    function iterateBadSpecArgs(i, cb) {
      if (i >= notStringArgs.length) return cb()
      // An empty object for spec will eventually produce an error, but it has
      // nothing to do with aproba validation, so we skip that here
// ANALYSIS: it's "TypeError: Cannot read property '0' of undefined", coming out of npa,
// where it's used in pacote.manifest (mock or not)
      if (notStringArgs[i] == {}) return iterateBadSpecArgs(i+1, cb)
      fetchPkgMetadata(notStringArgs[i], where, {}, function(err, data) {
        expect(err).to.be.an('error')
        expect(data).to.not.exist
        iterateBadSpecArgs(i+1, cb)
      })
    }

    iterateBadSpecArgs(0, done)
  })

  it('should pass back an error if `where` argument is not a string', function(done) {
    function iterateBadWhereArgs(i, cb) {
      if (i >= notStringArgs.length) return cb()
      fetchPkgMetadata(testSpec.version, notStringArgs[i], {}, function(err, data) {
        expect(err).to.be.an('error')
        expect(data).to.not.exist
        iterateBadWhereArgs(i+1, cb)
      })
    }

    iterateBadWhereArgs(0, done)
  })

  it('should pass back an error if `opts` argument is not an object or function', function(done) {
    function iterateBadOptsArgs(i, cb) {
      if (i >= notOptsOrFn.length) return cb()
      fetchPkgMetadata(testSpec.version, where, notOptsOrFn[i], function(err, data) {
        expect(err).to.be.an('error')
        expect(data).to.not.exist
        iterateBadOptsArgs(i+1, cb)
      })
    }

    iterateBadOptsArgs(0, done)
  })

  const unknowableSpec = 'no-such-package@999.999.999'
  it('when not offline, should pass back an error if the package spec is unknown to pacote', function(done) {
    npm.config.set('offline', false)
    fetchPkgMetadata(unknowableSpec, where, {}, function(err, data) {
      expect(err).to.be.an('error')
      expect(data).to.not.exist
      done()
    })
  })
  it('when offline, should pass back an error if the package spec is unknown to the download tracker', function(done) {
    npm.config.set('offline', true)
    fetchPkgMetadata(unknowableSpec, where, {}, function(err, data) {
      expect(err).to.be.an('error').that.matches(/Download Tracker knows nothing about/)
      expect(data).to.not.exist
      done()
    })
  })

  if (process.platform != 'win32') {
    it('should pass back an error on attempt to install from windows path on non-windows system', function(done) {
      // The error is only raised if the target is a directory
      const win32path = path.win32.join('C:', __dirname, 'fixtures', 'dummy')
      fetchPkgMetadata(win32path, where, {}, function(err, data) {
        expect(err).to.be.an('error').that.matches(/non-windows system/)
        expect(data).to.not.exist
        done()
      })
    })
  }

/*
  // Conceptually, '' is an invalid spec, and no doubt it would cause an error
  // *somewhere* beyond the module we test here; but it's not an error to npa,
  // so it doesn't cause one here, so it's not worth making an assertion about it.
  it('should show me something', function(done) {
    fetchPkgMetadata('', where, function(err, data) {
      console.log('$$$ err:', err)
      console.log('$$$ data:', data)
      done()
    })
  })
*/

  describe('When --offline is not given, behavior is that of unmodified npm', function() {
    let manifest
    let npaRegResult

    before('Ensure the offline switch is off', function() {
      npm.config.set('offline', false)
      npaRegResult = npa(testSpec.version)
    })

    describe('Given a string spec of a known package, yields a manifest, with certain properties added', function() {
      it('should have the `_requested` property set as pacote.manifest returns it, as the npa parse of given spec', function(done) {
        const npaResult = npa(testSpec.version)
        fetchPkgMetadata(testSpec.version, where, {}, function(err, data) {
          expect(err).to.not.exist
          expect(data).to.be.an('object')
            .that.has.all.keys('_from', '_requested', '_spec', '_where')
          expect(data._requested).to.deep.equal(npaResult)
          manifest = data
          done()
        })
      })

      it('should have a `_where` property set to the given `where` value', function() {
        expect(manifest._where).to.equal(where)
      })

      it('should have `_from` and `_spec` properties left as received from pacote.manifest', function() {
        expect(manifest._from).to.equal(npaRegResult.saveSpec || npaRegResult.raw)
        expect(manifest._spec).to.equal(npaRegResult.raw)
      })
    })

    describe('Given an npa parse of a valid spec of a known package, yields a manifest, with certain properties added', function() {
      it('should have the `_requested` property set as pacote.manifest returns it, as the given npa object', function(done) {
        const npaResult = npa(testSpec.version)
        fetchPkgMetadata(npaResult, where, {}, function(err, data) {
          expect(err).to.not.exist
          expect(data).to.be.an('object')
            .that.has.all.keys('_from', '_requested', '_spec', '_where')
          expect(data._requested).to.deep.equal(npaResult)
          manifest = data
          done()
        })
      })

      it('should have a `_where` property set to the given `where` value', function() {
        expect(manifest._where).to.equal(where)
      })

      it('should have `_from` and `_spec` properties left as received from pacote.manifest', function() {
        expect(manifest._from).to.equal(npaRegResult.saveSpec || npaRegResult.raw)
        expect(manifest._spec).to.equal(npaRegResult.raw)
      })
    })
  })

  describe('When --offline is given, behavior is that of offline npm-two-stage', function() {
    let manifest
    let npaRegResult
    let npaFileResult

    before('Set the offline switch', function() {
      npm.config.set('offline', true)
      npaRegResult = npa(testSpec.version)
      const tarballFilename = mockData.getFilename(npaRegResult)
      npaFileResult = npa(path.join(mockData.path, tarballFilename))
    })
    after('Revert the offline switch', function() {
      npm.config.set('offline', false)
    })

    describe('Given a string spec of a known package, yields a manifest, with certain properties added', function() {
      it('should have the `_requested` property set to the npa parse of given spec', function(done) {
        fetchPkgMetadata(testSpec.version, where, {}, function(err, data) {
          expect(err).to.not.exist
          expect(data).to.be.an('object')
            .that.has.all.keys('_from', '_requested', '_spec', '_where')
          expect(data._requested).to.deep.equal(npaRegResult)
          manifest = data
          done()
        })
      })

      it('should have a `_where` property set to the given `where` value', function() {
        expect(manifest._where).to.equal(where)
      })

      it('should have `_from` and `_spec` properties referencing the local file spec, as pacote.manifest sets them', function() {
        expect(manifest._from).to.equal(npaFileResult.saveSpec || npaFileResult.raw)
        expect(manifest._spec).to.equal(npaFileResult.raw)
      })
    })

    describe('Given an npa parse of a valid spec of a known package, yields a manifest, with certain properties added', function() {
      it('should have the `_requested` property set to given npa object', function(done) {
        fetchPkgMetadata(npaRegResult, where, {}, function(err, data) {
          expect(err).to.not.exist
          expect(data).to.be.an('object')
            .that.has.all.keys('_from', '_requested', '_spec', '_where')
          expect(data._requested).to.deep.equal(npaRegResult)
          manifest = data
          done()
        })
      })

      it('should have a `_where` property set to the given `where` value', function() {
        expect(manifest._where).to.equal(where)
      })

      it('should have `_from` and `_spec` properties referencing the local file spec, as pacote.manifest sets them', function() {
        expect(manifest._from).to.equal(npaFileResult.saveSpec || npaFileResult.raw)
        expect(manifest._spec).to.equal(npaFileResult.raw)
      })
    })
  })
})
