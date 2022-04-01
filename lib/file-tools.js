/*
  NOTE concerning needs of npm-two-stage install:
  Currently we only have flat directories to add;
  but nested directories in the future are conceivable.

  NOTE: fs.readdir option withFileTypes added in node.js v10.10.0.
  When we update this for that, we won't need to use lstat
  BUT we will have non-trivial refactoring to do
*/
const Emitter = require('events')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const copyFileAsync = promisify(fs.copyFile) // copyFile added in v8.5.0.
const lstatAsync = promisify(fs.lstat)
const mkdirAsync = promisify(fs.mkdir)
const readdirAsync = promisify(fs.readdir)
const rmdirAsync = promisify(fs.rmdir)
const unlinkAsync = promisify(fs.unlink)
const { COPYFILE_EXCL } = fs.constants

let emitter
module.exports.setEmitter = function(o) {
  if (o === undefined || o === null)
    throw new SyntaxError('No argument given')
  if (o instanceof Emitter) return emitter = o
  throw new TypeError('Given argument is not an Emitter')
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
        p = copyFileAsync(srcItemPath, target, COPYFILE_EXCL)
      else {
        p = Promise.resolve()
        if (emitter)
          emitter.emit('msg',
            `Not a regular file or a directory, omitting ${srcItemPath}`
          )
      }
      return p.then(() => nextEntry(offset, list, i+1))
    })
  }

  return readdirAsync(src)
  .then(entries => nextEntry('', entries, 0))
}

/*
  cp case: copy directory src into directory dest
*/
module.exports.graft =
function graft(src, dest) {
  const newPath = path.join(dest, path.basename(src))
  return mkdirAsync(newPath).then(() => copyEntries(src, newPath))
}

/*
  rm case: all the items on list are expected to be regular files.
  * if not absolute, assume each path is relative to current directory.
*/
module.exports.removeFiles =
function removeFiles(list) {
  function nextFile(i) {
    if (i >= list.length) return Promise.resolve()
    return unlinkAsync(list[i])
    .catch(err => {
      if (err.code != 'ENOENT') throw err
      if (emitter)
        emitter.emit('msg', `Could not find file ${list[i]} for removal`)
    })
    .then(() => nextFile(i+1))
  }
  return nextFile(0)
}

/*
  rm case: the kind of each item on list must be discovered before removal
*/
function removeEntries(offset, list, i) {
  if (i >= list.length) return Promise.resolve()
  const item = list[i]
  const itemPath = path.join(offset, item)
  return lstatAsync(itemPath).then(stats => {
    const p = stats.isDirectory() ? prune(itemPath) : unlinkAsync(itemPath)
    return p.then(() => removeEntries(offset, list, i+1))
    .catch(err => {
      if (err.code != 'ENOENT') throw err
      // Here we know it's a file, because prune() already handles ENOENT
      if (emitter)
        emitter.emit('msg', `Could not find file ${item} for removal`)
    })
  })
}

/*
  rm case: given item is expected to be a directory
*/
module.exports.prune =
function prune(dir) {
  return readdirAsync(dir)
  .then(entries => removeEntries(dir, entries, 0))
  .then(() => rmdirAsync(dir))
  .catch(err => {
    if (err.code != 'ENOENT') throw err
    if (emitter)
      emitter.emit('msg', `Could not find directory ${dir} for removal`)
  })
}
