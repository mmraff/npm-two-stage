/*
  TODO maybe:
  * Break out a new define() to group the shrinkwrap cases
*/
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)

const expect = require('chai').expect
const npa = require('npm-package-arg')
const rimrafAsync = promisify(require('rimraf'))

const makeAssets = require('./lib/make-assets')
const mockCommitHash = require('./lib/mock-commit-hash')

const npmRegistryPrefix = 'https:/' + '/registry.npmjs.org/'
const testData = {
  registry: [
    {
      name: '@offliner/root-pkg',
      version: '1.2.3',
      _resolved: npmRegistryPrefix + '@offliner/root-pkg/-/root-pkg-1.2.3.tgz'
    },
    {
      name: '@offliner/reg-dep',
      version: '2.3.4',
      _resolved: npmRegistryPrefix + '@offliner/reg-dep/-/reg-dep-2.3.4.tgz'
    },
    {
      name: '@offliner/dev-dep',
      version: '3.2.1',
      _resolved: npmRegistryPrefix + '@offliner/dev-dep/-/dev-dep-3.2.1.tgz'
    },
    {
      name: '@offliner/opt-dep',
      version: '0.1.2',
      _resolved: npmRegistryPrefix + '@offliner/opt-dep/-/opt-dep-0.1.2.tgz'
    },
    {
      name: '@offliner/dummy',
      version: '1.0.0',
      _resolved: npmRegistryPrefix + '@offliner/dummy/-/dummy-1.0.0.tgz'
    }
  ],
  git: [
    {
      spec: 'bitbucket:bbuser/bbproject',
      altSpec: 'git://bitbucket.org/bbuser/bbproject.git',
      sha: mockCommitHash(),
      pkg: {
        name: 'bbproject',
      }
    },
    {
      spec: 'git://github.com/ghuser/ghproject',
      altSpec: 'ghuser/ghproject#green',
      sha: mockCommitHash(),
      pkg: {
        name: 'ghproject',
      }
    }
  ]
}

// We will always use the following referenced items in the same way,
// hence the names.
const rootData = testData.registry[0]
const rootSpec = `${rootData.name}@${rootData.version}`
const depData = testData.registry[1]
const depSpec = `${depData.name}@${depData.version}`
const devDepData = testData.registry[2]
const devDepSpec = `${devDepData.name}@${devDepData.version}`
const optDepData = testData.registry[3]
const optDepSpec = `${optDepData.name}@${optDepData.version}`
const spareDepData = testData.registry[4]
const spareSpec = `${spareDepData.name}@${spareDepData.version}`

// One with all kinds of dependency sections, with only registry specs,
// for standard tests:
const pkgWithDeps = {
  ...rootData,
  dependencies: { [depData.name]: depData.version },
  devDependencies: { [devDepData.name]: devDepData.version },
  optionalDependencies: { [optDepData.name]: optDepData.version }
}

const shrWrapTemplate = {
  name: rootData.name, version: rootData.version,
  lockfileVersion: 1, requires: true
}
const commonShrinkwrap = { ...shrWrapTemplate, dependencies: {} }

// Set up commonShrinkwrap with all-registry dependencies
for (let i = 1; i < 4; ++i) {
  const item = testData.registry[i]
  const dep = commonShrinkwrap.dependencies[item.name] = {
    version: item.version, resolved: item.resolved
  }
  if (item === devDepData) dep.dev = true
  else if (item === optDepData) dep.optional = true
}

describe('download module', function() {
  const realSrcDir = path.resolve(__dirname, '..', 'src')
  const mockSrcDir = path.join(__dirname, 'fixtures', 'self-mocks', 'src')
  let assets
  let download
  let mockGitAux
  let minNpf
  let mockNpm
  let mockPacote
  let mockFinalizeManifest

  function copyToTestDir(relPath, opts) {
    if (!opts) opts = {}
    const srcPath = path.join(opts.mock ? mockSrcDir : realSrcDir, relPath)
    const newFilePath = `${assets.npmLib}/${relPath}`
    const p = copyFileAsync(srcPath, path.resolve(__dirname, newFilePath))
    return opts.getModule ? p.then(() => require(newFilePath)) : p
  }

  // For checking that dlTracker.add() was called
  function expectDlTrackerData(pkgData, mustExist) {
    const storedData = mockNpm.dlTracker.getData(
      'semver', pkgData.name, pkgData.version
    )
    if (mustExist) {
      const expectedFilename = minNpf.makeTarballName({
        type: 'semver', name: pkgData.name, version: pkgData.version
      })
      expect(storedData).to.have.property('filename', expectedFilename)
    }
    else expect(storedData).to.not.exist
  }

  before('set up test directory', function(done) {
    makeAssets('download', 'download.js', { mockDownloadDir: true })
    .then(result => {
      assets = result
      mockNpm = require(assets.npmLib + '/npm')
      mockNpm.config.set('no-dl-summary', true)
      mockNpm.tmp = assets.fs('npmTmp') // download.js creates dl-temp-cache there

      mockPacote = require(assets.nodeModules + '/pacote')
      mockFinalizeManifest = require(assets.nodeModules + '/pacote/lib/finalize-manifest')

      mockGitAux = require(assets.npmLib + '/download/git-aux')
      minNpf = require(assets.npmLib + '/download/npm-package-filename')
      return copyToTestDir('download.js', { getModule: true })
      .then(mod => {
        download = mod
        done()
      })
    })
    .catch(err => done(err))
  })

  after('remove temporary assets', function(done) {
    rimrafAsync(assets.fs('rootName')).then(() => done())
    .catch(err => done(err))
  })

  it('should pass back an error if no package is identified', function(done) {
    download([], function(err, results) {
      try {
        expect(err).to.be.an.instanceof(SyntaxError)
          .that.matches(/No packages named for download/)
        expect(results).to.not.exist
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.false
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should pass back an error if download tracker instance creation fails', function(done) {
    mockNpm.dlTracker.setErrorState('create', true, 'EDUMMY')
    download([ 'dummy@latest' ], function(err, results) {
      mockNpm.dlTracker.setErrorState('create', false)
      try {
        expect(err).to.be.an('error')
        expect(results).to.not.exist
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should pass back an error on request for unknown package', function(done) {
    download([ 'unknowable@999.999.999' ], function(err, results) {
      try {
        expect(err).to.be.an('error')
        expect(results).to.not.exist
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.false
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should pass back an error on request for package of unhandled type', function(done) {
    download([ 'local/filesystem/package' ], function(err, results) {
      try {
        expect(err).to.match(/Cannot download package of type directory/)
        expect(results).to.not.exist
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.false
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should pass back an error if the fetched manifest is missing critical fields', function(done) {
    function causeAnError(pkgData, errorPattern, next) {
      mockPacote.addTestMetadata(spec, pkgData)
      download([ spec ], function(err, results) {
        try {
          expect(err).to.be.an('error').that.matches(errorPattern)
          expect(results).to.not.exist
          expect(mockNpm.dlTracker.serializeWasCalled()).to.be.false
        }
        catch (assertErr) { return done(assertErr) }
        next()
      })
    }

    const spec = '@offliner/dummy@1.2.3'
    mockPacote.addTestSpec(spec)
    download([ spec ], function(err, results) {
      try {
        expect(err).to.be.an('error').that.matches(/No _resolved value in manifest/)
        expect(results).to.not.exist
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.false
      }
      catch (assertErr) { return done(assertErr) }
      doInvalidTypeResolved()
    })
    function doInvalidTypeResolved() {
      causeAnError(
        { _resolved: true }, /Invalid _resolved value in manifest/,
        doEmptyStrResolved
      )
    }
    function doEmptyStrResolved() {
      causeAnError(
        { _resolved: ' ' }, /Unable to parse a path from _resolved field/,
        done
      )
    }
  })

  it('should pass back an error if the download tracker fails to add package data', function(done) {
    mockPacote.addTestMetadata(rootSpec, rootData)
    mockNpm.dlTracker.purge()
    mockNpm.dlTracker.setErrorState('add', true, 'EDUMMY') // For a real example, we could do 'ENOENT'...

    download([ rootSpec ], function(err, results) {
      mockNpm.dlTracker.setErrorState('add', false)
      try {
        expect(err).to.be.an('error')
        expect(results).to.not.exist
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.false
        const storedData = mockNpm.dlTracker.getData(
          'semver', rootData.name, rootData.version
        )
        expect(storedData).to.not.exist
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should succeed on request for existing simple registry package that has good metadata', function(done) {
    function checkForExpectedResults(results) {
      // Comment taken from near end of download():
      // "results is an array of arrays, 1 for each spec on the command line."
      expect(results).to.deep.equal([
        [ { spec: rootSpec, name: rootData.name } ],
        [ { spec: rootSpec, name: rootData.name, duplicate: true } ]
      ])
      expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
      expectDlTrackerData(rootData, true)
    }

    mockPacote.addTestMetadata(rootSpec, rootData)
    download([ rootSpec, rootSpec ], function(err, results) { // extra spec for coverage of duplicate case
      try {
        expect(err).to.not.exist
        checkForExpectedResults(results)
      }
      catch (assertErr) { return done(assertErr) }

      // Again, but give the --dl-dir option:
      mockNpm.dlTracker.purge()
      mockNpm.config.set('dl-dir', assets.fs('pkgPath'))
      download([ rootSpec, rootSpec ], function(err, results) {
        try {
          expect(err).to.not.exist
          checkForExpectedResults(results)
        }
        catch (assertErr) { return done(assertErr) }
        done()
      })
    })
  })

  it('same when package is specified by a valid tag', function(done) {
    // For coverage.
    const tag = 'next'
    const spec1 = `${rootData.name}@${tag}`
    mockNpm.dlTracker.purge()
    mockPacote.addTestMetadata(spec1, rootData)
    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.deep.equal([
          [ { spec: spec1, name: rootData.name } ]
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(rootData, true)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('same for a package with dependencies', function(done) {
    mockNpm.dlTracker.purge()
    const testData1 = pkgWithDeps
    const spec1 = `${testData1.name}@${testData1.version}`
    mockPacote.addTestMetadata(spec1, testData1)
    mockPacote.addTestMetadata(depSpec, depData)
    mockPacote.addTestMetadata(devDepSpec, devDepData)
    mockPacote.addTestMetadata(optDepSpec, optDepData)

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: spec1, name: testData1.name },
          { spec: depSpec, name: depData.name },
          { spec: optDepSpec, name: optDepData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, true)
        expectDlTrackerData(optDepData, true)
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('same for a package with a devDependency, when --include=dev', function(done) {
    const testData1 = pkgWithDeps
    const spec1 = `${testData1.name}@${testData1.version}`
    mockPacote.addTestMetadata(spec1, testData1)
    mockNpm.dlTracker.purge()
    mockNpm.config.set('include', 'development,dev') // other value for coverage

    download([ spec1 ], function(err, results) {
      mockNpm.config.set('include', undefined)
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: spec1, name: testData1.name },
          { spec: depSpec, name: depData.name },
          { spec: optDepSpec, name: optDepData.name },
          { spec: devDepSpec, name: devDepData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, true)
        expectDlTrackerData(optDepData, true)
        expectDlTrackerData(devDepData, true)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  // IMPORTANT: this must come after test "same for a package with a devDependency, when --include=dev"
  it('should yield same results given --also=dev as when given --include=dev', function(done) {
    const testData1 = pkgWithDeps
    const spec1 = `${testData1.name}@${testData1.version}`
    mockNpm.dlTracker.purge()
    mockNpm.config.set('also', 'dev')

    function checkForExpectedData(actualData) {
      expect(actualData).to.be.an('array').that.has.lengthOf(1)
      expect(actualData[0]).to.have.deep.members([
        { spec: spec1, name: testData1.name },
        { spec: depSpec, name: depData.name },
        { spec: optDepSpec, name: optDepData.name },
        { spec: devDepSpec, name: devDepData.name }
      ])
      expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
      expectDlTrackerData(testData1, true)
      expectDlTrackerData(depData, true)
      expectDlTrackerData(optDepData, true)
      expectDlTrackerData(devDepData, true)
    }

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        checkForExpectedData(results)
      }
      catch (assertErr) { return done(assertErr) }

      // Try again, with both include=dev and also=dev
      mockNpm.dlTracker.purge()
      mockNpm.config.set('include', 'dev')
      download([ spec1 ], function(err, results) {
        mockNpm.config.set('also', undefined)
        mockNpm.config.set('include', undefined)
        try {
          expect(err).to.not.exist
          checkForExpectedData(results)
        }
        catch (assertErr) { return done(assertErr) }
        done()
      })
    })
  })

  it('should skip dependencies that are listed in bundleDependencies array', function(done) {
    const testData1 = Object.assign({}, pkgWithDeps)
    const spec1 = `${testData1.name}@${testData1.version}`
    testData1.bundleDependencies =
      Object.keys(testData1.dependencies)
      .concat(Object.keys(testData1.devDependencies))
      .concat(Object.keys(testData1.optionalDependencies))
    mockPacote.addTestMetadata(spec1, testData1)
    mockNpm.config.set('include', 'dev')
    mockNpm.dlTracker.purge()

    download([ spec1 ], function(err, results) {
      mockNpm.config.set('include', undefined)
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.deep.equal([
          { spec: spec1, name: testData1.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, false)
        expectDlTrackerData(optDepData, false)
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should skip dependencies if bundleDependencies is true', function(done) {
    const testData1 = Object.assign({}, pkgWithDeps)
    const spec1 = `${testData1.name}@${testData1.version}`
    testData1.bundleDependencies = true
    mockPacote.addTestMetadata(spec1, testData1)
    mockNpm.dlTracker.purge()

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.deep.equal([
          { spec: spec1, name: testData1.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, false)
        expectDlTrackerData(optDepData, false)
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should only fetch top level packages and devDependencies when --only=dev', function(done) {
    mockNpm.dlTracker.purge()
    const testData1 = pkgWithDeps
    const spec1 = `${testData1.name}@${testData1.version}`
    mockPacote.addTestMetadata(spec1, testData1)
    mockNpm.config.set('only', 'dev')

    download([ spec1 ], function(err, results) {
      mockNpm.config.set('only', undefined)
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: spec1, name: testData1.name },
          { spec: devDepSpec, name: devDepData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, false)
        expectDlTrackerData(optDepData, false)
        expectDlTrackerData(devDepData, true)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should not fetch optionalDependencies when --no-optional is given', function(done) {
    const testData1 = pkgWithDeps
    const spec1 = `${testData1.name}@${testData1.version}`
    mockPacote.addTestMetadata(spec1, testData1)
    mockNpm.config.set('no-optional', true)
    mockNpm.dlTracker.purge()

    download([ spec1 ], function(err, results) {
      mockNpm.config.set('no-optional', undefined)
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: spec1, name: testData1.name },
          { spec: depSpec, name: depData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, true)
        expectDlTrackerData(optDepData, false)
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should succeed on request for existing registry item without a version spec', function(done) {
    /*
      WARNING: it is vital that the the same item is used in the two tests
      immediately following this one, else we lose coverage, and then some
      of the tests are pointless.
    */
    const testData1 = testData.registry[4]
    mockPacote.addTestMetadata(testData1.name, testData1)
    mockNpm.dlTracker.purge()

    download([ testData1.name ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.deep.equal([
          { spec: testData1.name, name: testData1.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should report duplicate and not download item where no-version spec resolves to item previously downloaded', function(done) {
    const testData1 = testData.registry[4]
    // No dlTracker.purge() here.

    download([ testData1.name ], function(err, results) {
      try {
        expect(err).to.be.false
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.deep.equal([
          { spec: testData1.name, name: testData1.name, duplicate: true }
        ])
/*
  I didn't write a way to check whether anything has actually been downloaded
  when the download session resolves, so dlTracker.serialize() is called even
  in that case, hence the following expect; but when there have been no calls
  to dlTracker.add(), serialize() sends back `false` instead of an error, and
  that gets sent to the final callback, hence the expect(err).to.be.false
*/
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should report duplicate and not download item where range spec resolves to item previously downloaded', function(done) {
    const testData1 = testData.registry[4]
    const rangeSpec = testData1.name + '@' + '>1'
    mockPacote.addTestMetadata(rangeSpec, testData1)
    // No dlTracker.purge() here.

    download([ rangeSpec ], function(err, results) {
      try {
        expect(err).to.be.false
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.deep.equal([
          { spec: rangeSpec, name: testData1.name, duplicate: true }
        ])
        // Same comment as above applies here
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should pass back an error if a non-optional dependency fetch fails', function(done) {
    const testData1 = pkgWithDeps
    const spec1 = `${testData1.name}@${testData1.version}`
    mockNpm.dlTracker.purge()
    mockPacote.purgeTestData()
    mockPacote.addTestMetadata(optDepSpec, optDepData)
    mockPacote.addTestMetadata(spec1, testData1)
    // Not added: the regular dependency; the devDependency

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.be.an('error')
        expect(results).to.not.exist
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.false
        expectDlTrackerData(testData1, false)
        expectDlTrackerData(depData, false)
        expectDlTrackerData(optDepData, true) // because mockPacote knows this one
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should report if an optional dependency fetch fails, but succeed anyway', function(done) {
    const testData1 = pkgWithDeps
    const spec1 = `${testData1.name}@${testData1.version}`
    mockNpm.dlTracker.purge()
    mockPacote.purgeTestData()
    mockPacote.addTestMetadata(depSpec, depData)
    mockPacote.addTestMetadata(spec1, testData1)
    // Not added: the optionalDependency; the devDependency

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: optDepSpec, failedOptional: true },
          { spec: spec1, name: testData1.name },
          { spec: depSpec, name: depData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, true)
        expectDlTrackerData(optDepData, false)
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should pass back an error if a non-optional dependency fetch fails for a shrinkwrap', function(done) {
    const testData1 = Object.assign({}, pkgWithDeps)
    testData1._shrinkwrap = commonShrinkwrap
    const spec1 = `${testData1.name}@${testData1.version}`
    mockNpm.dlTracker.purge()
    mockPacote.purgeTestData()
    mockPacote.addTestMetadata(optDepSpec, optDepData)
    mockPacote.addTestMetadata(spec1, testData1)
    // Not added: the regular dependency; the devDependency

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.be.an('error')
        expect(results).to.not.exist
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.false
        expectDlTrackerData(testData1, false)
        expectDlTrackerData(depData, false)
        expectDlTrackerData(optDepData, true) // because mockPacote knows this one
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should report if an optional dependency fetch fails for a shrinkwrap, but succeed anyway', function(done) {
    const testData1 = Object.assign({}, pkgWithDeps)
    testData1._shrinkwrap = commonShrinkwrap
    const spec1 = `${testData1.name}@${testData1.version}`
    mockNpm.dlTracker.purge()
    mockPacote.purgeTestData()
    mockPacote.addTestMetadata(depSpec, depData)
    mockPacote.addTestMetadata(spec1, testData1)
    // Not added: the optionalDependency; the devDependency

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: optDepSpec, failedOptional: true },
          { spec: spec1, name: testData1.name },
          { spec: depSpec, name: depData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, true)
        expectDlTrackerData(optDepData, false)
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  // IMPORTANT: this test should immediately follow the
  // "optional dependency fetch fails for a shrinkwrap" test, else we must
  // load it down with the same setup lines...
  it('should skip optional dependency in a shrinkwrap if --no-optional given', function(done) {
    const testData1 = Object.assign({}, pkgWithDeps)
    testData1._shrinkwrap = commonShrinkwrap
    const spec1 = `${testData1.name}@${testData1.version}`
    mockPacote.addTestMetadata(optDepSpec, optDepData)
    mockNpm.dlTracker.purge()
    mockNpm.config.set('no-optional', true)

    download([ spec1 ], function(err, results) {
      mockNpm.config.set('no-optional', undefined)
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: spec1, name: testData1.name },
          { spec: depSpec, name: depData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, true)
        expectDlTrackerData(optDepData, false)
        expectDlTrackerData(devDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should skip bundled dependencies in a shrinkwrap', function(done) {
    const dep2Data = testData.registry[4]
    const dep2Spec = `${dep2Data.name}@${dep2Data.version}`
    const testData1 = Object.assign({}, rootData)
    testData1.dependencies = {
      [depData.name]: '^' + depData.version,
      [dep2Data.name]: '^' + dep2Data.version
    }
    // Technically, should add bundledDependencies to testData1 to correlate
    // to shrinkwrap data below, but download.js won't be looking at that
    // if there's a shrinkwrap.
    testData1._shrinkwrap = Object.assign({}, shrWrapTemplate)
    testData1._shrinkwrap.dependencies = {
      [depData.name]: {
        version: depData.version,
        bundled: true
      },
      [dep2Data.name]: {
        version: dep2Data.version
      }
    }
    mockPacote.purgeTestData()
    mockPacote.addTestMetadata(rootSpec, testData1)
    mockPacote.addTestMetadata(depSpec, depData)
    mockPacote.addTestMetadata(dep2Spec, dep2Data)
    mockNpm.dlTracker.purge()

    download([ rootSpec ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: rootSpec, name: testData1.name },
          { spec: dep2Spec, name: dep2Data.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, false)
        expectDlTrackerData(dep2Data, true)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should skip optional dependency in a shrinkwrap "requires" if --no-optional given', function(done) {
    const testData1 = Object.assign({}, testData.registry[0])
    testData1.dependencies = { [depData.name]: '^' + depData.version }
    testData1._shrinkwrap = Object.assign({}, shrWrapTemplate)
    testData1._shrinkwrap.dependencies = {
      [depData.name]: {
        version: depData.version,
        requires: {
          [optDepData.name]: '^' + optDepData.version
        }
      },
      [optDepData.name]: {
        version: optDepData.version,
        optional: true
      }
    }
    mockPacote.purgeTestData()
    const spec1 = `${testData1.name}@${testData1.version}`
    mockPacote.addTestMetadata(spec1, testData1)
    mockPacote.addTestMetadata(depSpec, depData)
    mockPacote.addTestMetadata(optDepSpec, optDepData)
    mockNpm.dlTracker.purge()
    mockNpm.config.set('no-optional', true)

    download([ spec1 ], function(err, results) {
      mockNpm.config.set('no-optional', undefined)
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: spec1, name: testData1.name },
          { spec: depSpec, name: depData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, true)
        expectDlTrackerData(optDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should skip all but devDependencies in a shrinkwrap if --only=dev given, #1', function(done) {
    const testData1 = {
      ...rootData,
      dependencies: { [spareDepData.name]: spareDepData.version },
      devDependencies: { [devDepData.name]: '^' + devDepData.version },
      _shrinkwrap: { ...shrWrapTemplate, dependencies: {} }
    }
    const wrap = testData1._shrinkwrap
    // Put all the other packages into the shrinkwrap
    for (let i = 1; i < 5; ++i) {
      const item = testData.registry[i]
      const dep = wrap.dependencies[item.name] = {
        version: item.version, resolved: item.resolved
      }
      if (item === devDepData) dep.dev = true
      if (item === optDepData) dep.optional = true
    }
    const shrWrapDevDepData = wrap.dependencies[devDepData.name]
    // Configure the regular dep and the optional dep as
    // regular deps of the dev dep (omit the spareDepData)
    shrWrapDevDepData.requires = {
      [depData.name]: '^' + depData.version,
      [optDepData.name]: '^' + optDepData.version // Also for coverage
    }

    mockPacote.purgeTestData()
    mockPacote.addTestMetadata(rootSpec, testData1)
    mockPacote.addTestMetadata(depSpec, depData)
    mockPacote.addTestMetadata(optDepSpec, optDepData)
    mockPacote.addTestMetadata(devDepSpec, devDepData)
    mockPacote.addTestMetadata(spareSpec, spareDepData)
    mockNpm.dlTracker.purge()
    mockNpm.config.set('only', 'dev')

    download([ rootSpec ], function(err, results) {
      mockNpm.config.set('only', undefined)
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: rootSpec, name: testData1.name },
          { spec: depSpec, name: depData.name },
          { spec: devDepSpec, name: devDepData.name },
          { spec: optDepSpec, name: optDepData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(testData1, true)
        expectDlTrackerData(depData, true)
        expectDlTrackerData(optDepData, true)
        expectDlTrackerData(devDepData, true)
        expectDlTrackerData(spareDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should skip all but devDependencies in a shrinkwrap if --only=dev given, #2', function(done) {
    const testData1 = {
      ...rootData,
      dependencies: {
        [depData.name]: depData.version,
        [spareDepData.name]: spareDepData.version
      },
      devDependencies: { [devDepData.name]: '^' + devDepData.version },
      _shrinkwrap: { ...shrWrapTemplate, dependencies: {} }
    }
    const wrap = testData1._shrinkwrap
    // Put all the other packages into the shrinkwrap
    for (let i = 1; i < 5; ++i) {
      const item = testData.registry[i]
      const dep = wrap.dependencies[item.name] = {
        version: item.version, resolved: item.resolved
      }
      // DON'T set a dev flag on the devDependency:
      // (according to the npmjs documentation for package-lock.json)
      // the dev property "is false for dependencies that are both a
      // development dependency of the top level and a transitive dependency
      // of a non-development dependency of the top level"
      // (actually, the dev property is not present in that case).
      if (item === optDepData) dep.optional = true
    }
    const depDataInWrap = wrap.dependencies[depData.name]
    // Configure the dev dep as a regular dep of the 1st top-level regular dep
    depDataInWrap.requires = { [devDepData.name]: '^' + devDepData.version }

    mockPacote.purgeTestData()
    mockPacote.addTestMetadata(rootSpec, testData1)
    mockPacote.addTestMetadata(depSpec, depData)
    mockPacote.addTestMetadata(optDepSpec, optDepData)
    mockPacote.addTestMetadata(devDepSpec, devDepData)
    mockPacote.addTestMetadata(spareSpec, spareDepData)
    mockNpm.dlTracker.purge()
    mockNpm.config.set('only', 'dev')

    download([ rootSpec ], function(err, results) {
      mockNpm.config.set('only', undefined)
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: rootSpec, name: rootData.name },
          { spec: devDepSpec, name: devDepData.name }
        ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(rootData, true)
        expectDlTrackerData(depData, false)
        expectDlTrackerData(optDepData, false)
        expectDlTrackerData(devDepData, true)
        expectDlTrackerData(spareDepData, false)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  describe('use of package.json options for fetching dependencies', function() {
    function expectPJResults(actual, extra) {
      expect(actual).to.be.an('array').that.has.lengthOf(extra ? 2 : 1)
      expect(actual[0]).to.have.deep.members([
        { spec: depSpec, name: depData.name },
        { spec: optDepSpec, name: optDepData.name }
      ])
      expectDlTrackerData(depData, true)
      expectDlTrackerData(optDepData, true)
      if (extra) {
        expect(actual[1]).to.deep.equal([{ spec: extra.spec, name: extra.pkg.name }])
        expectDlTrackerData(extra.pkg, true)
      }
      expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
    }

    it('should succeed when given --package-json set to path with a package.json', function(done) {
      mockPacote.addTestMetadata(assets.fs('installPath'), pkgWithDeps)
      mockPacote.addTestMetadata(depSpec, depData)
      mockPacote.addTestMetadata(devDepSpec, devDepData)
      mockPacote.addTestMetadata(optDepSpec, optDepData)

      mockNpm.dlTracker.purge()
      mockNpm.config.set('package-json', assets.fs('installPath'))
      download([], function(err, results) {
        mockNpm.config.set('package-json', undefined)
        expect(err).to.not.exist
        expectPJResults(results)
        done()
      })
    })

    // --pj is an alias for --package-json; 'package.json' need not be in the
    // path for either, but if it is, download.js handles it gracefully
    it('should succeed when given --pj set to path of package.json file', function(done) {
      mockNpm.dlTracker.purge()
      mockNpm.config.set('pj', path.join(assets.fs('installPath'), 'package.json'))
      download([], function(err, results) {
        mockNpm.config.set('pj', undefined)
        expect(err).to.not.exist
        expectPJResults(results)
        done()
      })
    })

    it('should succeed when given -J option, provided that the CWD has a package.json file', function(done) {
      const startDir = process.cwd()
      mockNpm.dlTracker.purge()
      mockNpm.config.set('J', true)
      process.chdir(assets.fs('installPath')) // because download.js will use process.cwd()
      download([], function(err, results) {
        process.chdir(startDir)
        mockNpm.config.set('J', undefined)
        expect(err).to.not.exist
        expectPJResults(results)
        done()
      })
    })

    it('should succeed when given a package spec in addition to the --package-json option', function(done) {
      mockNpm.dlTracker.purge()
      mockNpm.config.set('package-json', assets.fs('installPath'))
      // Once more, but with a package spec in the arguments:
      const pkgData = testData.registry[4]
      const pkgSpec = `${pkgData.name}@>=${pkgData.version}`
      mockPacote.addTestMetadata(pkgSpec, pkgData)
      download([ pkgSpec ], function(err, results) {
        mockNpm.config.set('package-json', undefined)
        expect(err).to.not.exist
        expectPJResults(results, { spec: pkgSpec, pkg: pkgData })
        done()
      })
    })
  })

  it('should succeed on request for basic known git package that fetches good metadata', function(done) {
    const g0 = testData.git[0]
    const spec1 = g0.spec
    const gitAuxData = {
      [spec1]: {
        sha: g0.sha, ref: 'master', type: 'branch',
        allRefs: [ 'master', 'optimus' ]
      }
    }
    const finalizerData = { [spec1]: {} }
    mockGitAux.setTestConfig(gitAuxData)
    mockFinalizeManifest.setTestConfig(finalizerData)
    mockNpm.dlTracker.purge()

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.deep.equal([ [ { spec: spec1 } ] ])
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        const npaSpec = npa(spec1)
        const repo = npaSpec.hosted.domain + '/' + npaSpec.hosted.path()
        const commit = gitAuxData[spec1].sha
        const storedData1 = mockNpm.dlTracker.getData(
          'git', repo, commit
        )
        const expectedFilename1 = minNpf.makeTarballName({
          type: 'git',
          domain: npaSpec.hosted.domain, path: npaSpec.hosted.path(),
          commit
        })
        expect(storedData1).to.have.property('filename', expectedFilename1)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  // Simulate a commit that is no longer associated with a tag
  it('should insert commit hash into manifest._ref when git.revs gives nothing', function(done) {
    const g0 = testData.git[0]
    const spec1 = g0.spec + '#' + g0.sha
    const gitAuxData = { [spec1]: null }
    const finalizerData = { [spec1]: {} }
    mockGitAux.setTestConfig(gitAuxData)
    mockFinalizeManifest.setTestConfig(finalizerData)
    mockNpm.dlTracker.purge()

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.deep.equal([ [ { spec: spec1 } ] ])
        const npaSpec = npa(spec1)
        const repo = npaSpec.hosted.domain + '/' + npaSpec.hosted.path()
        // Here we build the expected filename like this, but download.js
        // builds it using manifest._ref.sha, so we must check the dlData
        // (also, dlData.commit gets set with manifest._ref.sha)
        const expectedFilename = minNpf.makeTarballName({
          type: 'git', commit: g0.sha,
          domain: npaSpec.hosted.domain, path: npaSpec.hosted.path()
        })
        const dlData = mockNpm.dlTracker.getData('git', repo, g0.sha)
        expect(dlData).to.have.property('filename', expectedFilename)
        expect(dlData).to.not.have.property('refs')
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })
  // case: there is no manifest._ref; spec has a gitCommittish, but it's not
  // a hash.
  // The need for the code that this tests(line 678) depends on whether pacote
  // ever returns a manifest when it has ultimately failed to determine the
  // commit hash value. We assume 'yes' and fake that case here.
  it('should pass back error if spec.gitCommittish is not a SHA, and manifest from pacote has no _ref data', function(done) {
    const g1 = testData.git[1]
    const testTag = (function(){
      const match = g1.altSpec.match(/#.+$/)
      // Just double-checking the test data before using it:
      expect(match).to.be.an('array').that.is.not.empty
      expect(match[0]).to.have.lengthOf.above(1)
      return match[0].slice(1)
    })()
    mockGitAux.setTestConfig({ [g1.altSpec]: null })
    mockFinalizeManifest.setTestConfig({ [g1.altSpec]: {} })
    mockNpm.dlTracker.purge()

    download([ g1.altSpec ], function(err, results) {
      expect(err).to.match(/failed to obtain the commit hash/)
      expect(results).to.not.exist
      done()
    })
  })

  // It's debatable whether this test is necessary for download.js...
  // but it doesn't hurt.
  // * it is thrown in pacote/lib/finalize-manifest (function: tarballedProps())
  // * pacote finalizeManifest is called in download.js (function: gitManifest())
  it('should pass error through if referenced state of git repo has no package.json', function(done) {
    const g1 = testData.git[1]
    const spec = g1.spec + '#' + g1.sha
    mockGitAux.setTestConfig({ [spec]: {} })
    mockFinalizeManifest.setErrorState(true, 'ENOPACKAGEJSON')

    download([ spec ], function(err, results) {
      mockFinalizeManifest.setErrorState(false)
      // It's a mock error - we don't need to check the message
      expect(err.code).to.equal('ENOPACKAGEJSON')
      expect(results).to.not.exist
      done()
    })
  })

  it('should report a duplicate git spec', function(done) {
    function verifyGitRepoDlData(spec) {
      const npaSpec = npa(spec)
      const repo = npaSpec.hosted.domain + '/' + npaSpec.hosted.path()
      const storedData = mockNpm.dlTracker.getData(
        'git', repo, gitAuxData[spec].sha
      )
      const expectedFilename = minNpf.makeTarballName({
        type: 'git',
        domain: npaSpec.hosted.domain, path: npaSpec.hosted.path(),
        commit: gitAuxData[spec].sha
      })
      expect(storedData).to.have.property('filename', expectedFilename)
    }

    const spec1 = testData.git[0].spec
    const dep1Name = testData.git[1].pkg.name
    const spec2Sha = testData.git[1].sha
    const spec2 = `${testData.git[1].spec}#${spec2Sha}`
    const dep2Name = testData.git[0].pkg.name
    const npaSpec = npa(spec1)
    const gitAuxData = {
      [spec1]: { sha: testData.git[0].sha },
      [spec2]: { sha: spec2Sha }
    }
    const finalizerData = {
      [spec1]: {
        dependencies: { [dep1Name]: spec2 }
      },
      [spec2]: {
        dependencies: { [dep2Name]: testData.git[0].altSpec }
          // Discovery: specifying that differently than spec1
          // buys us nothing in coverage.
      }
    }

    mockGitAux.setTestConfig(gitAuxData)
    mockFinalizeManifest.setTestConfig(finalizerData)
    mockNpm.dlTracker.purge()

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: spec1 },
          { spec: dep1Name + '@' + spec2, name: dep1Name },
          {
            spec: dep2Name + '@' + finalizerData[spec2].dependencies[dep2Name],
            name: dep2Name, duplicate: true
          }
        ])
        verifyGitRepoDlData(spec1)
        verifyGitRepoDlData(spec2)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should report duplicate and not download fully specified git item previously downloaded', function(done) {
    const spec1 = `${testData.git[0].spec}#${testData.git[0].sha}`
    // No dlTracker.purge() here.

    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.be.false // err value from serialize()
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.deep.equal([{ spec: spec1, duplicate: true }])
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should correctly identify an unresolved transitive git dependency in a shrinkwrap', function(done) {
    const testData1 = Object.assign(
      { dependencies: { [depData.name]: depData.version } },
      rootData
    )
    const gitDepData = testData.git[1]
    const gitDepFullSpec = gitDepData.spec + '#' + gitDepData.sha
    const shrinkwrap = Object.assign({}, shrWrapTemplate)
    shrinkwrap.dependencies = {
      [depData.name]: {
        version: depData.version,
        requires: {
          [gitDepData.pkg.name]: gitDepData.altSpec
        }
      },
      [gitDepData.pkg.name]: {
        version: gitDepFullSpec,
        from: gitDepData.altSpec
      }
    }
    testData1._shrinkwrap = shrinkwrap
    const rootSpec = `${testData1.name}@${testData1.version}`
    const depSpec = `${depData.name}@${depData.version}`
    mockPacote.purgeTestData()
    mockPacote.addTestMetadata(rootSpec, testData1)
    mockPacote.addTestMetadata(depSpec, depData)
    const gitAuxData = {
      [gitDepFullSpec]: { sha: gitDepData.sha }
    }
    const finalizerData = { [gitDepFullSpec]: {} }
    mockGitAux.setTestConfig(gitAuxData)
    mockFinalizeManifest.setTestConfig(finalizerData)
    mockNpm.dlTracker.purge()

    download([ rootSpec ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        expect(results[0]).to.have.deep.members([
          { spec: rootSpec, name: rootData.name },
          { spec: depSpec, name: depData.name },
          {
            spec: gitDepData.pkg.name + '@' + gitDepFullSpec,
            name: gitDepData.pkg.name
          }
        ])
        expectDlTrackerData(rootData, true)
        expectDlTrackerData(depData, true)
        // Figure out what dlData to expect for the git repo package:
        const npaSpec = npa(gitDepData.spec)
        const repo = npaSpec.hosted.domain + '/' + npaSpec.hosted.path()
        const storedData = mockNpm.dlTracker.getData(
          'git', repo, gitDepData.sha
        )
        const expectedFilename = minNpf.makeTarballName({
          type: 'git',
          domain: npaSpec.hosted.domain, path: npaSpec.hosted.path(),
          commit: gitDepData.sha
        })
        expect(storedData).to.have.property('filename', expectedFilename)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should correctly handle complex dependency relationships in a shrinkwrap', function(done) {
    // Although it would never work in the wild, we don't need to add a
    // dependencies section into any of the data we set in mockPacote except
    // the top-level package, since this is a shrinkwrap download, where
    // the manifests of dependencies are ignored.
    const pkgName1 = 'pkg1'
    const pkgName2 = 'pkg2'
    const pkgName3 = 'pkg3'
    const dep1aData = {
      name: pkgName1, version: '1.1.0',
      _resolved: `${npmRegistryPrefix}${pkgName1}/-/${pkgName1}-1.1.0.tgz`
    }
    const dep3aData = {
      name: pkgName3, version: '3.1.0',
      _resolved: `${npmRegistryPrefix}${pkgName3}/-/${pkgName3}-3.1.0.tgz`
    }
    const dep2aData = {
      name: pkgName2, version: '2.1.0',
      _resolved: `${npmRegistryPrefix}${pkgName2}/-/${pkgName2}-2.1.0.tgz`
    }
    const dep1bData = {
      name: pkgName1, version: "2.2.0",
      _resolved: `${npmRegistryPrefix}${pkgName1}/-/${pkgName1}-2.2.0.tgz`
    }
    const dep2bData = {
      name: pkgName2, version: "1.3.0",
      _resolved: `${npmRegistryPrefix}${pkgName2}/-/${pkgName2}-1.3.0.tgz`
    }
    const dep3bData = {
      name: pkgName3, version: "1.2.0",
      _resolved: `${npmRegistryPrefix}${pkgName3}/-/${pkgName3}-1.2.0.tgz`
    }

    const shrinkwrap = Object.assign({}, shrWrapTemplate)
    shrinkwrap.dependencies = {
      [pkgName1]: {
        version: dep1aData.version
      },
      [pkgName2]: {
        version: dep2aData.version,
        requires: {
          [pkgName1]: "^2.0.0", // matches inner
          [pkgName3]: "^1.0.0" // matches inner
        },
        dependencies: {
          [pkgName1]: {
            version: dep1bData.version
          },
          [pkgName3]: {
            version: dep3bData.version,
            requires: {
              [pkgName1]: dep1aData.version, // matches outermost
              [pkgName2]: "^1.0.0" // matches inner
            },
            dependencies: {
              [pkgName2]: {
                version: dep2bData.version
              }
            }
          }
        }
      },
      [pkgName3]: {
        version: dep3aData.version
      }
    }
    const rootData = Object.assign(
      {
        dependencies: {
          [pkgName1]: dep1aData.version,
          [pkgName2]: dep2aData.version,
          [pkgName3]: dep3aData.version
        }
      },
      testData.registry[0]
    )
    rootData._shrinkwrap = shrinkwrap
    const rootSpec = `${rootData.name}@${rootData.version}`
    const specMap = {
      [rootSpec] : rootData,
      [`${pkgName1}@${dep1aData.version}`]: dep1aData,
      [`${pkgName2}@${dep2aData.version}`]: dep2aData,
      [`${pkgName3}@${dep3aData.version}`]: dep3aData,
      [`${pkgName1}@${dep1bData.version}`]: dep1bData,
      [`${pkgName2}@${dep2bData.version}`]: dep2bData,
      [`${pkgName3}@${dep3bData.version}`]: dep3bData
    }
    mockPacote.purgeTestData()
    for (const spec in specMap)
      mockPacote.addTestMetadata(spec, specMap[spec])

    mockNpm.dlTracker.purge()

    download([ rootSpec ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.be.an('array').that.has.lengthOf(1)
        const expectedData = Object.keys(specMap).map(spec => (
          { spec, name: specMap[spec].name }
        ))
        expect(results[0]).to.have.deep.members(expectedData)
        expect(mockNpm.dlTracker.serializeWasCalled()).to.be.true
        expectDlTrackerData(rootData, true)
        expectDlTrackerData(dep1aData, true)
        expectDlTrackerData(dep1bData, true)
        expectDlTrackerData(dep2aData, true)
        expectDlTrackerData(dep2bData, true)
        expectDlTrackerData(dep3aData, true)
        expectDlTrackerData(dep3bData, true)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })

  it('should succeed on request for existing basic remote package that fetches good metadata', function(done) {
    const spec1 = 'https:/' + '/supersite.com/projectZ/archive/b999999.tgz'
    const testData1 = {
      name: 'project-z',
      version: '7.7.7',
      _resolved: spec1
    }
    mockPacote.addTestMetadata(spec1, testData1)
    download([ spec1 ], function(err, results) {
      try {
        expect(err).to.not.exist
        expect(results).to.deep.equal([ [ { spec: spec1 } ] ])
        const storedData = mockNpm.dlTracker.getData('url', null, spec1)
        const expectedFilename = minNpf.makeTarballName({
          type: 'url',
          url: spec1
        })
        expect(storedData).to.have.property('filename', expectedFilename)
      }
      catch (assertErr) { return done(assertErr) }
      done()
    })
  })
})
