const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const renameAsync = promisify(fs.rename)

const rimrafAsync = promisify(require('rimraf'))

const ft = require('../../lib/file-tools')

const mockNPM = path.resolve(__dirname, '../fixtures/mock-npm')
const mockN2S = path.resolve(__dirname, '../fixtures/self-mocks')

function cloneSrcFile(assets, relFilepath) {
  const fileSrcPath = path.resolve(__dirname, '../../src', relFilepath)
  const destPath = path.resolve(__dirname, '..', assets.npmLib, relFilepath)
  return copyFileAsync(fileSrcPath, destPath)
}

class TestAssets {
  constructor (rootName, opts = {}) {
    this.rootName = rootName
    this.opts = { ...opts }
  }
  // Getters each return a minimal '/'-delimited path suitable for require()
  // when concatenated with a script filepath; but DON'T PASS TO path.join()!
  // because that will strip the './' prefix.
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
  get installPath () {
    return `./${this.rootName}/installTgt`
  }
  get pkgPath () {
    return `./${this.rootName}/dlpkgs`
  }

  // In some cases, a full path normalized to the current platform is best
  fs (assetName) {
    const asset = this[assetName]
    if (!asset) throw new Error(`Unrecognized asset '${assetName}'`)
    return path.resolve(__dirname, '..', asset)
  }

  // Generate a fresh copy of the assets
  make (testTarget) {
    const startDir = process.cwd()
    const testRootDir = this.fs('rootName')
    const npmLibDir = this.fs('npmLib')
    return rimrafAsync(testRootDir)
    .then(() => mkdirAsync(testRootDir))
    .then(() => mkdirAsync(this.fs('npmTmp')))
    .then(() => mkdirAsync(this.fs('installPath')))
    .then(() => mkdirAsync(this.fs('pkgPath')))
    .then(() => {
      return ft.graft(mockNPM, testRootDir)
      .then(() => {
        process.chdir(testRootDir)
        return renameAsync('mock-npm', 'npm')
      })
      .then(() => process.chdir(startDir))
    })
    .then(() => {
      // For each test suite, it must be determined whether the mock download
      // directory should be copied to npm/lib/:
      return this.opts.mockDownloadDir ?
        ft.graft(path.join(mockN2S, 'src/download'), npmLibDir) :
        mkdirAsync(this.fs('libDownload'))
    })
    /*.then(() => 
      cloneSrcFile(this, path.join('download', 'npm-package-filename.js'))
    )*/
    .then(() => cloneSrcFile(this, testTarget))
    .then(() => this)
  }
}

module.exports = (rootName, testTarget, opts) =>
  (new TestAssets(rootName, opts)).make(testTarget)
