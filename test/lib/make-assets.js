const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const renameAsync = promisify(fs.rename)

const mkdirp = require('mkdirp')
const rimrafAsync = promisify(require('rimraf'))

const graft = require('./graft')

const _offliner = Symbol('_offliner')
const _arborist = Symbol('_arborist')
const _singleFiles = Symbol('_n2s_singleFiles')
const _nodeModules = Symbol('_n2s_node_modules')

const fixtures = {
  root: path.join(__dirname, '..', 'fixtures')
}
fixtures.mockNPM = path.join(fixtures.root, 'mock-npm')
fixtures.mockN2S = path.join(fixtures.root, 'self-mocks')

// TODO: make sure our fixtures are set up so that no matter what the dirname()
// of an item on the list, it will already exist, so that we don't have to
// mkdirp first
const cloneNpmFiles = (list, destBase) => {
  const nextFile = (i) => {
    if (i >= list.length) return Promise.resolve()
    const srcPath = path.resolve(
      __dirname, '../../node_modules/npm', list[i]
    )
    return copyFileAsync(srcPath, path.join(destBase, list[i]))
    .then(() => nextFile(i + 1))
  }
  return nextFile(0)
}

const cloneNodeModules = (list, destBase) => {
  const nextModule = (i) => {
    if (i >= list.length) return Promise.resolve()
    const srcPath = path.resolve(
      __dirname, '../../node_modules/npm/node_modules', list[i]
    )
    return graft(srcPath, destBase)
    .then(() => nextModule(i + 1))
  }
  return nextModule(0)
}

const cloneSrcFile = (assets, relFilepath) => {
  const fileSrcPath = path.resolve(__dirname, '../../src', relFilepath)
  const destPath = path.resolve(__dirname, '..', assets.npmLib, relFilepath)
  return copyFileAsync(fileSrcPath, destPath)
}

class TestAssets {
  constructor (rootName, opts = {}) {
    this.rootName = rootName
    this[_offliner] = !!opts.offliner
    this[_arborist] = !!opts.arborist
    this[_singleFiles] = opts.verbatim ? opts.verbatim.files || [] : []
    this[_nodeModules] = opts.verbatim ? opts.verbatim.node_modules || [] : []
  }
  // Getters each return a minimal '/'-delimited path suitable for require()
  // (when concatenated with a script filepath, of course)
  get npm () {
    return `./${this.rootName}/npm`
  }
  get nodeModules () {
    return `./${this.rootName}/npm/node_modules`
  }
  get npmLib () {
    return `./${this.rootName}/npm/lib`
  }
  get npmTmp () {
    return `./${this.rootName}/tmp`
  }
  get libDownload () {
    return `./${this.npmLib}/download`
  }
  get libOffliner () {
    return `./${this.npmLib}/offliner`
  }
  // A place to identify as an installation target, put a package.json, ...
  get installPath () {
    return `./${this.rootName}/installTgt`
  }
  // A place to put/find tarballs, if necessary:
  get pkgPath () {
    return `./${this.rootName}/dlpkgs`
  }
  // In some cases, a full path normalized to the current platform is best:
  fs (assetName) {
    const asset = this[assetName]
    if (!asset) throw new Error(`Unrecognized asset '${assetName}'`)
    return path.resolve(__dirname, '..', asset)
  }

  // Actualize a fresh copy of the assets
  make (testTarget) {
    const startDir = process.cwd()
    const testRootDir = this.fs('rootName')
    const npmLibDir = this.fs('npmLib')
    return rimrafAsync(testRootDir)
    .then(() => mkdirAsync(testRootDir))
    .then(() => mkdirAsync(this.fs('npmTmp')))
    .then(() => mkdirAsync(this.fs('pkgPath')))
    .then(() =>
      this[_arborist] ?
        // It's unfortunate that they didn't implement true unit tests, but we
        // can't mock any npm/node_modules when we're using test suites borrowed
        // from @npmcli/arborist.
        // Also, something is using a funky version of mkdirp,
        // so we can't use that here.
        mkdirAsync(path.join(testRootDir, 'npm'))
        .then(() => mkdirAsync(path.join(testRootDir, 'npm/lib')))
      : graft(fixtures.mockNPM, testRootDir)
        .then(() => {
          process.chdir(testRootDir)
          return renameAsync('mock-npm', 'npm')
        })
        .then(() => process.chdir(startDir))
    )
    .then(() => cloneNpmFiles(this[_singleFiles], this.fs('npm')))
    .then(() => cloneNodeModules(this[_nodeModules], this.fs('nodeModules')))
    .then(() => graft(
      path.join(fixtures.mockN2S, 'src/download'), npmLibDir
    ))
    .then(() => {
      if (this[_offliner])
        return (this[_arborist]
          ? graft(path.resolve(__dirname, '../../src/offliner'), npmLibDir)
          : graft(path.join(fixtures.mockN2S, 'src/offliner'), npmLibDir)
        )
        .then(() => mkdirAsync(this.fs('installPath')))
    })
    .then(() =>
      cloneSrcFile(this, path.join('download', 'npm-package-filename.js'))
    )
    .then(() => 
      cloneSrcFile(this, path.join('download', 'git-tracker-keys.js'))
    )
    .then(() => cloneSrcFile(this, testTarget))
    .then(() => this)
  }
}

module.exports = (rootName, testTarget, opts) =>
  (new TestAssets(rootName, opts)).make(testTarget)

