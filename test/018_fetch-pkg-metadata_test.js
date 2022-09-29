const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)

const expect = require('chai').expect
const npa = require('npm-package-arg')
const rimrafAsync = promisify(require('rimraf'))

const makeAssets = require('./lib/make-assets')

describe('fetch-package-metadata replacement module', function() {
  const realSrcDir = path.resolve(__dirname, '../src')
  const mockSrcDir = path.join(__dirname, 'fixtures/self-mocks/src')
  const dummyFn = function(){}
  const testSpec = {
    winPath: path.win32.join(
      /^[a-zA-Z]:/.test(__dirname) ? '' : 'C:',
      __dirname, 'fixtures', 'dummy'
    )
  }
  let assets
  let fetchPkgMetadata
  let mockData
  let npm
  let pacote
  let homeOfIsWindows

  function copyToTestDir(relPath, opts) {
    if (!opts) opts = {}
    const srcPath = path.join(opts.mock ? mockSrcDir : realSrcDir, relPath)
    const newFilePath = `${assets.npmLib}/${relPath}`
    const p = copyFileAsync(srcPath, path.resolve(__dirname, newFilePath))
    return opts.getModule ? p.then(() => require(newFilePath)) : p
  }

  before('set up test directory', function(done) {
    makeAssets('fetchPkgMeta', 'fetch-package-metadata.js', { mockDownloadDir: true }) // TODO: Yes?
    .then(result => {
      assets = result
      homeOfIsWindows = path.join(assets.fs('npmLib'), 'utils')
      // We get this so that we can toggle offline mode:
      npm = require(assets.npmLib + '/npm')
      // We get this so that we can make some packages appear to be available
      // and prevent mock-pacote.manifest from erroring:
      pacote = require(assets.nodeModules + '/pacote')
      // Helper for tests; no counterpart in actual installation.
      // Mock offliner also requires this.
      return copyToTestDir('mock-dl-data.js', { mock: true, getModule: true })
    })
    .then(mod => {
      mockData = mod
      testSpec.byVersion = mockData.getSpec('version')
      pacote.addTestSpec(testSpec.byVersion)
      pacote.addTestSpec(testSpec.winPath)
      testSpec.byTag = mockData.getSpec('tag', 1)
      // but don't add that one

      // dirty hack to help get to 100% coverage:
      // For one of two tests in this suite, we need to be able to mock a
      // Windows/non-Windows platform. As simple as it is, the actual
      // 'is-windows' module restricts us too much.
      const startDir = process.cwd()
      process.chdir(homeOfIsWindows)
      return copyFileAsync(
        process.platform === 'win32' ? 'yes-is-windows.js' : 'not-is-windows.js',
        'is-windows.js'
      )
      .catch(err => {
        process.chdir(startDir)
        throw err
      })
      .then(() => process.chdir(startDir))
    })
    .then(() => copyToTestDir('offliner.js', { mock: true }))
    .then(() => copyToTestDir('fetch-package-metadata.js', { getModule: true }))
    .then(mod => {
      fetchPkgMetadata = mod
      done()
    })
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    rimrafAsync(assets.fs('rootName')).then(() => done())
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
      fetchPkgMetadata(testSpec.byVersion, notStringArgs[i], {}, function(err, data) {
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
      fetchPkgMetadata(testSpec.byVersion, where, notOptsOrFn[i], function(err, data) {
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

  function reloadFpmModule() {
    const modPath = path.join(assets.fs('npmLib'), 'fetch-package-metadata.js')
    delete require.cache[modPath]
    delete require.cache[path.join(homeOfIsWindows, 'is-windows.js')]
    fetchPkgMetadata = require(modPath)
  }

  it('should pass back an error on attempt to install from windows path on non-windows system', function(done) {
    const startDir = process.cwd()
    process.chdir(homeOfIsWindows)
    copyFileAsync('not-is-windows.js', 'is-windows.js')
    .then(() => {
      process.chdir(startDir)
      reloadFpmModule()
      // The error is only raised if the target is an absolute path to a directory
      fetchPkgMetadata(testSpec.winPath, where, {}, function(err, data) {
        expect(err).to.be.an('error').that.matches(/non-windows system/)
        expect(data).to.not.exist
        done()
      })
    })
  })

  it('should not error when given a windows path on a windows system', function(done) {
    const startDir = process.cwd()
    process.chdir(homeOfIsWindows)
    copyFileAsync('yes-is-windows.js', 'is-windows.js')
    .then(() => {
      process.chdir(startDir)
      reloadFpmModule()
      fetchPkgMetadata(testSpec.winPath, where, {}, function(err, data) {
        expect(err).to.not.exist
        expect(data).to.be.an('object')
        done()
      })
    })
  })

  it('should pass back any error from pacote related to a directory spec', function(done) {
    const opts = { tracker: { finish: () => {} } } // Needed for coverage
    // To get full coverage, must use a spec that gets interpreted as a directory:
    const dummySpec = 'does/not/matter'

    // In arg lists of calls in the following, 'nullStack':
    // The unmodified fetch-package-metadata code branches on whether the error
    // from manifest() has a stack. This causes our coverage test to say that the
    // line in question is uncovered because the error is found to have a stack.
    // AFAIK, an Error instance *always* has a stack - it's automatically
    // generated at the point of creation.
    // Luckily, error.stack is mutable, so it can be set to null, which is
    // not something a sensible coder would ordinarily do; but here we must
    // do it for coverage, so that feature is implemented in the pacote mock.

    function tryNotDir(nullStack) {
      pacote.setErrorState('manifest', true, 'ENOTDIR', nullStack)
      fetchPkgMetadata(dummySpec, where, opts, function(err, data) {
        expect(err).to.be.an('error').that.matches(/is not a directory and is not a file/)
        expect(err.code).to.equal('ENOLOCAL')
        expect(data).to.not.exist
        tryNoPkgJson(nullStack)
      })
    }
    function tryNoPkgJson(nullStack) {
      pacote.setErrorState('manifest', true, 'ENOPACKAGEJSON', nullStack)
      fetchPkgMetadata(dummySpec, where, {}, function(err, data) {
        expect(err).to.be.an('error').that.matches(/does not contain a package\.json file/)
        expect(err.code).to.equal('ENOLOCAL')
        expect(data).to.not.exist
        if (nullStack) tryOtherError()
        else tryNotDir(true)
      })
    }
    function tryOtherError() {
      pacote.setErrorState('manifest', true, 'EWHATEVER')
      fetchPkgMetadata(dummySpec, where, {}, function(err, data) {
        expect(err).to.be.an('error')
        expect(err.code).to.equal('EWHATEVER')
        expect(data).to.not.exist
        pacote.setErrorState('manifest', false)
        done()
      })
    }
    tryNotDir()
  })

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
      npaRegResult = npa(testSpec.byVersion)
    })

    describe('Given a string spec of a known package, yields a manifest, with certain properties added', function() {
      it('should have the `_requested` property set as pacote.manifest returns it, as the npa parse of given spec', function(done) {
        const npaResult = npa(testSpec.byVersion)
        fetchPkgMetadata(testSpec.byVersion, where, {}, function(err, data) {
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

      it('should succeed for same spec if opts object is omitted', function(done) {
        fetchPkgMetadata(testSpec.byVersion, where, function(err, data) {
          expect(err).to.not.exist
          expect(data).to.deep.equal(manifest)
          done()
        })
      })
    })

    describe('Given an npa parse of a valid spec of a known package, yields a manifest, with certain properties added', function() {
      it('should have the `_requested` property set as pacote.manifest returns it, as the given npa object', function(done) {
        const npaResult = npa(testSpec.byVersion)
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
      npaRegResult = npa(testSpec.byVersion)
      const tarballFilename = mockData.getFilename(npaRegResult)
      npaFileResult = npa(path.join(mockData.path, tarballFilename))
    })
    after('Revert the offline switch', function() {
      npm.config.set('offline', false)
    })

    describe('Given a string spec of a known package, yields a manifest, with certain properties added', function() {
      it('should have the `_requested` property set to the npa parse of given spec', function(done) {
        fetchPkgMetadata(testSpec.byVersion, where, {}, function(err, data) {
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
