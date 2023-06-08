const { COPYFILE_EXCL } = require('fs').constants
const { copyFile, lstat, mkdir, readdir, rm } = require('fs/promises')
const path = require('path')

/*
  copyEntries: Copy everything# in src into dest
  * assumes both src and dest are existing directories
  * recursive descent
  # non-file, non-directory entries are filtered out
*/
function copyEntries(src, dest) {

  function nextEntry(offset, list, i) {
    if (i >= list.length) return Promise.resolve()
    const item = list[i]
    const srcItemPath = path.join(src, offset, item)
    return lstat(srcItemPath).then(srcStats => {
      const target = path.join(dest, offset, item)
      let p
      if (srcStats.isDirectory())
        p = readdir(srcItemPath).then(entries =>
          mkdir(target)
          .then(() => nextEntry(path.join(offset, item), entries, 0))
        )
      else if (srcStats.isFile())
        p = copyFile(srcItemPath, target, COPYFILE_EXCL)
      else {
        // This should never happen, but potential harm is neutralized
        p = Promise.resolve()
        console.warn(
          'copyEntries: Not a regular file or a directory, omitting',
          srcItemPath
        )
      }
      return p.then(() => nextEntry(offset, list, i+1))
    })
  }

  return readdir(src)
  .then(entries => nextEntry('', entries, 0))
}

module.exports = function (src, dest) {
  let newPath
  // Leave argument validation to that built into the path module
  try { newPath = path.join(dest, path.basename(src)) }
  catch (err) { return Promise.reject(err) }
  let mkdirSucceeded = false
  return mkdir(newPath).then(() => {
    mkdirSucceeded = true
    return copyEntries(src, newPath)
  })
  .catch(err => {
    if (mkdirSucceeded) {
      return rm(newPath, { recursive: true, force: true })
      .then(() => { throw err })
    }
    throw err
  })
}

