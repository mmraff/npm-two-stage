const fs = require('fs')

const tar = require('tar')

module.exports = (tarball, priorityList) =>
  new Promise((resolve, reject) => {
    const arg1Msg = 'First argument must be path to a tarball'
    const arg2Msg = 'Second argument must be an array of one or more filepaths'
    if (tarball === undefined || tarball === null || tarball === '')
      return reject(new SyntaxError(arg1Msg))
    if (typeof tarball !== 'string')
      return reject(new TypeError(arg1Msg))
    if (!priorityList)
      return reject(new SyntaxError(arg2Msg))
    if (!Array.isArray(priorityList))
      return reject(new TypeError(arg2Msg))
    if (!priorityList.length)
      return reject(new SyntaxError(arg2Msg))
    for (const item of priorityList) {
      if (typeof item !== 'string') return reject(new TypeError(arg2Msg))
      if (!item) return reject(new SyntaxError(arg2Msg))
    }

    let error = null
    const onInitError = err => {
      error = err
    }
    const onInitClose = () => {
      // If this listener gets called, an error will surely have been set
      reject(error)
    }
    const rstr = fs.createReadStream(tarball)
    .once('error', onInitError)
    .once('close', onInitClose)
    .once('readable', () => {
      // If file is less than 3 bytes length, we get null for b.
      // We need to tell the difference between zero length and too short,
      // so we start by reading 1
      let b = rstr.read(1)
      if (!b) {
        error = Object.assign(
          new Error('File of zero length'),
          { code: 'EFZEROLEN', path: tarball }
        )
        return rstr.destroy()
      }
      rstr.unshift(b)
      b = rstr.read(3)
      if (!b || b[0] !== 0x1F && b[1] !== 0x8B && b[2] !== 0x08) {
        error = Object.assign(
          new Error('Not a gzipped file'),
          { code: 'EFTYPE', path: tarball }
        )
        return rstr.destroy()
      }
      rstr.removeListener('error', onInitError)
      rstr.removeListener('close', onInitClose)
      rstr.unshift(b)
      resolve(rstr)
    })
  })
  .then(rstr =>
    new Promise((resolve, reject) => {
    let bestIdxSoFar = priorityList.length
    // bad index ------^^^^^^^^^^^^^^^^^^^, but we never have to worry about it
    let content = null
    let start = 0
    let error
    rstr.once('error',
      /* istanbul ignore next: would need to simulate file system error */
      err => error = err
    )
    .once('close', () => {
      if (error) reject(error)
      else resolve({ name: priorityList[bestIdxSoFar], content })
    })

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
      start = 0
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
          rstr.destroy()
        }
      })
    }

    tarParser.on('entry', processEntry)
    .on('warn', function TPW(code, msg, data) {
      let errMsg
      switch (code) {
        case 'TAR_ENTRY_INVALID':
          errMsg = 'Invalid entry for a tar archive'
          break
        case 'TAR_BAD_ARCHIVE':
          errMsg = 'Does not look like a tar archive'
          break
        /* istanbul ignore next */
        default: return
      }
      tarParser.removeListener('warn', TPW)
      tarParser.emit('error', Object.assign(
        new Error(errMsg), { code: 'EFTYPE' }
      ))
    })
    .once('error', err => {
      tarParser.removeListener('entry', processEntry)
      tarParser.removeAllListeners('close')
      error = err
      rstr.destroy()
    })
    .once('close', function() {
      // The idea here is that if the target entry was found, we already
      // removed this listener, set content and closed the readStream, so
      // we can assume that if we get here, it means we had an error OR
      // we did not find any of the target entries.
      if (!content && !error) {
        error = new Error(`Target${priorityList.length > 1 ? 's' : ''} not found`)
        error.code = 'ENOMATCH'
      }
    })

    rstr.pipe(tarParser)
  }))
