const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile)
const lstatAsync = promisify(fs.lstat)
const mkdirAsync = promisify(fs.mkdir)
const readdirAsync = promisify(fs.readdir)
const renameAsync = promisify(fs.rename)

const rimrafAsync = promisify(require('rimraf'))

const mockNPM = path.resolve(__dirname, '../fixtures/mock-npm')
const mockN2S = path.resolve(__dirname, '../fixtures/self-mocks')

function cloneSrcFile(assets, relFilepath) {
  const fileSrcPath = path.resolve(__dirname, '../../src', relFilepath)
  const destPath = path.resolve(__dirname, '..', assets.npmLib, relFilepath)
  return copyFileAsync(fileSrcPath, destPath)
}

/*
  Copy everything in src into dest
  * assumes both src and dest are existing directories
  * recursive descent
*/
function copyEntries(src, dest) {

  function nextEntry(offset, list, i) {
    if (i >= list.length) return Promise.resolve()
    const item = list[i]
    const srcItemPath = path.join(src, offset, item)
    return lstatAsync(srcItemPath).then(srcStats => {
      const target = path.join(dest, offset, item)
      let p
      if (srcStats.isDirectory())
        p = readdirAsync(srcItemPath).then(entries =>
          mkdirAsync(target)
          .then(() => nextEntry(path.join(offset, item), entries, 0))
        )
      else if (srcStats.isFile())
        p = copyFileAsync(srcItemPath, target, fs.constants.COPYFILE_EXCL)
      else
        p = Promise.resolve()

      return p.then(() => nextEntry(offset, list, i+1))
    })
  }

  return readdirAsync(src)
  .then(entries => nextEntry('', entries, 0))
}

function graft(src, dest) {
  if (src === undefined || src === null || src === '')
    return Promise.reject(new SyntaxError('Source argument must not be empty'))
  if (dest === undefined || dest === null || dest === '')
    return Promise.reject(new SyntaxError('Destination argument must not be empty'))
  let newPath
  try { newPath = path.join(dest, path.basename(src)) }
  catch (err) { return Promise.reject(err) }
  return mkdirAsync(newPath)
  .then(() => copyEntries(src, newPath))
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
      return graft(mockNPM, testRootDir)
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
        graft(path.join(mockN2S, 'src/download'), npmLibDir) :
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
