const fs = require('fs')

const tar = require('tar')

// Determined by creating a tar file, using --delete to remove the content,
// gzipping it, then taking the size of the result:
// If file given as tarball is not at least this size, it can't possibly be a
// complete gzipped tar file
const MIN_TARBALL_SIZE = 57
// In contrast, a basic gzipped tar file with a single entry that is empty is
// found to be 115 bytes in size

module.exports = (tarball, priorityList) => new Promise((resolve, reject) => {
  const arg1Msg = 'First argument must be path to a tarball'
  const arg2Msg = 'Second argument must be an array of one or more filepaths'
  if (tarball === undefined || tarball === null || tarball === '')
    return reject(new SyntaxError(arg1Msg))
  if (typeof tarball !== 'string')
    return reject(new TypeError(arg1Msg))
  if (!priorityList)
    return reject(new SyntaxError(arg2Msg))
  if (!(priorityList instanceof Array))
    return reject(new TypeError(arg2Msg))
  if (!priorityList.length)
    return reject(new SyntaxError(arg2Msg))
  for (const item of priorityList) {
    if (typeof item !== 'string') return reject(new TypeError(arg2Msg))
    if (!item) return reject(new SyntaxError(arg2Msg))
  }

  let bestIdxSoFar = priorityList.length
  // bad index ------^^^^^^^^^^^^^^^^^^^, but we never have to worry about it
  let content = null
  let start = 0
  let error = null
  // Not using 'strict' here because when it's not a gzipped tar file, the
  // resulting error output indicates that tarParser tries too hard before it
  // figures out that it's not looking at a tarball; also, there may be some
  // warnings that we don't care enough about to blow them up into errors.
  const tarParser = new tar.Parse()
  const processEntry = entry => {
    /* istanbul ignore next */
    if (entry.ignore || entry.meta) return entry.resume()

    // It's meaningless to send back non-file data
    if (entry.type != 'File') return entry.resume()

    // In this context, we should be able to assume that the full paths of
    // all entries begin with "<root_name>/"
    const childPath = entry.path.replace(/^[^\/\\]+[\/\\]/, '')
    const idx = priorityList.indexOf(childPath)
    if (idx < 0) return entry.resume()
    if (idx < bestIdxSoFar) bestIdxSoFar = idx
    else return entry.resume()

    // For the case where we've previously found one of the items on
    // priorityList, so that a buffer is currently assigned to content:
    // There does not seem to be a way to release a buffer, except by
    // reassigning the variable, and leaving the old value to gc 
    content = Buffer.allocUnsafe(entry.size)
    entry.on('data', data => {
      data.copy(content, start, 0, data.length)
      start += data.length
    })
    entry.once('end', function () {
      entry.removeAllListeners('data')
      // if bestIdxSoFar is 0, we're done with the whole stream
      if (bestIdxSoFar === 0) {
        tarParser.removeListener('entry', processEntry)
        rstr.unpipe(tarParser)
        //tarParser.end() // doesn't seem to do anything
        rstr.destroy()
      }
    })
  }

  tarParser.on('entry', processEntry)
  .once('error', err => {
    //console.log('this is tarParser?', this === tarParser) // false
    tarParser.removeListener('entry', processEntry)
    error = err
  })
  .once('close', function() {
    if (!content && !error) {
      error = new Error(`Target${priorityList.length > 1 ? 's' : ''} not found`)
      error.code = 'ENOTFOUND'
    }
  })

  const rstr = fs.createReadStream(tarball)
  rstr.once('data', function OD (c) {
    //console.log('this is rstr?', this === rstr) // true
    // gzipped files all start with 1f8b08
    if (c.slice(0, 3).compare(Buffer.from([0x1F, 0x8B, 0x08])) !== 0) {
      rstr.emit('error', Object.assign(
        new Error('Not a gzipped file: ' + tarball),
        { code: 'EFTYPE', path: tarball }
      ))
    }
    else if (c.length < MIN_TARBALL_SIZE) {
      // nodejs api doc for fs.createReadStream: "unlike the default value set
      // for highWaterMark on a readable stream (16 kb), the stream returned by
      // this method has a default value of 64 kb for the same parameter."
      // --> length of the first chunk will be at least MIN_TARBALL_SIZE if the
      // file is a real gzipped tarball.
      rstr.emit('error', Object.assign(
        new Error('Truncated gzipped file: ' + tarball),
        { code: 'EFTRUNC', path: tarball }
      ))
    }
    // We're still on the 1st chunk, so we can restart:
    else {
      rstr.unshift(c)
      rstr.pipe(tarParser)
    }
  })
  .once('error', err => {
    //console.log('this is rstr?', this === rstr) // false
    error = err
  })
  .once('close', () => {
    if (error) reject(error)
    else resolve({ name: priorityList[bestIdxSoFar], content })
  })
})

