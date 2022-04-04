/*
  NOTE concerning needs of npm-two-stage install:
  Currently we only have flat directories to add;
  but nested directories in the future are conceivable.
*/
const Emitter = require('events')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const accessAsync = promisify(fs.access)
const lstatAsync = promisify(fs.lstat)
const mkdirAsync = promisify(fs.mkdir)
const readdirAsync = promisify(fs.readdir)
const rmdirAsync = promisify(fs.rmdir)
const unlinkAsync = promisify(fs.unlink)

let emitter
module.exports.setEmitter = function(o) {
  if (o === undefined || o === null)
    throw new SyntaxError('No argument given')
  if (o instanceof Emitter) return emitter = o
  throw new TypeError('Given argument is not an Emitter')
}

function expectNonemptyString(arg, name) {
  if (arg === undefined || arg === null)
    throw new SyntaxError(`No ${name} argument given`)
  if (typeof arg != 'string')
    throw new TypeError(`${name} argument must be a string`)
  if (!arg.length)
    throw new Error(`${name} argument must not be empty`)
}

function closeStream(str, cb) {
  if (typeof str.destroy == 'function') { // Added in node.js v8.0.0
    str.destroy()
    return cb()
  }
  // else
  fs.close(str.fd, function(closeErr) { cb(closeErr) })
}

/*
 A simplified implementation of cp
 * assume src to be a file; if not, just error out
 * assume path.dirname(dest) to be an existing directory; if not, just error out
 * assume dest does not exist; otherwise error out (do not overwrite)

 NOTE:
 * copyFile added to fs module in node.js v8.5.0.
*/
const copyFileAsync =
module.exports.copyFileAsync = function(src, dest) {
  try {
    expectNonemptyString(src, 'source')
    expectNonemptyString(dest, 'destination')
  }
  catch (err) { return Promise.reject(err) }

  let readEnded = false
  let hadError = false
  let alreadyResolved = false
  return new Promise((resolve, reject) => {
    function errorOut(err) {
      if (!hadError && !alreadyResolved) {
        hadError = true
        reject(err)
      }
    }
    let destStream
    const srcStream = fs.createReadStream(src)
    srcStream.once('end', () => { readEnded = true })
    .once('open', function() {
      const writeOpts = { flags: 'wx', encoding: null }
      destStream = fs.createWriteStream(dest, writeOpts)
      destStream.once('error', function(err) {
        if (!readEnded) closeStream(srcStream, function(closeErr) {})
        errorOut(err)
      })
      .once('finish', function() {
        if (!hadError) {
          alreadyResolved = true
          resolve()
        }
      })
      srcStream.pipe(destStream)
    })
    .once('error', function(err) {
      errorOut(err)
      /*
        node.js API doc for readable stream method pipe() says
        "...if the Readable stream emits an error during processing, the
         Writable destination is not closed automatically. If an error occurs,
         it will be necessary to manually close each stream in order to prevent
         memory leaks."
      */
      if (destStream) destStream.end(function() {
        fs.unlink(dest, function(rmErr) {})
      })
    })
  })
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
        p = copyFileAsync(srcItemPath, target)
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

function getEmptyArgError(name) {
  return new SyntaxError(`${name} argument must not be empty`)
}

/*
  cp case: copy directory src into directory dest
*/
module.exports.graft =
function graft(src, dest) {
  if (src == undefined || src === null || src === '')
    return Promise.reject(getEmptyArgError('Source'))
  if (dest == undefined || dest === null || dest === '')
    return Promise.reject(getEmptyArgError('Destination'))
  let newPath
  try { newPath = path.join(dest, path.basename(src)) }
  catch (err) { return Promise.reject(err) }
  let mkdirSucceeded = false
  return mkdirAsync(newPath).then(() => {
    mkdirSucceeded = true
    return copyEntries(src, newPath)
  })
  .catch(err => {
    if (mkdirSucceeded)
      return prune(newPath).then(() => { throw err })
    throw err
  })
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
  })
}

/*
  rm case: given item is expected to be a directory
*/
function prune(dir) {
  if (dir == undefined || dir === null || dir === '')
    return Promise.reject(getEmptyArgError('Target directory'))
  return readdirAsync(dir)
  .then(entries => removeEntries(dir, entries, 0))
  .then(() => rmdirAsync(dir))
}
module.exports.prune = prune
