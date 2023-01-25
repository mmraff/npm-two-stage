const fs = require('fs')
const http = require('http')
const path = require('path')
const {
  R_OK: READ_OK,
  X_OK: EXEC_OK
} = fs.constants

let server = null

exports.start = (home, opts) => new Promise((resolve, reject) => {
  if (server && server.listening)
    return reject(new Error('Remote server already started'))
  if (!opts) opts =  {}

  try { fs.accessSync(home, READ_OK | EXEC_OK) }
  catch (err ) { return reject(err) }

  server = http.createServer((req, res) => {
    res.setHeader('connection', 'close')
    let raw
    try { raw = fs.createReadStream(path.join(home, req.url)) }
    catch (err) {
      if (opts.debug) console.error('Remote server on createReadStream:', err)
      res.setHeader('content-type', 'text/plain')
      if (err.code === 'ENOENT') {
        res.statusCode = 404
        return res.end('Not found')
      }
      else {
        // Surprise: we don't ever get EISDIR here
        res.statusCode = 500
        return res.end('Ouch: ' + err.message)
      }
    }
    res.setHeader('content-type', 'application/octet-stream')
    if (opts.debug)
      res.once('close', () =>
        console.log('Remote server: connection closed, request:', req.url)
      )
    let hadError = false
    const doErrorResponse = err => {
      if (hadError) return
      hadError = true
      raw.unpipe(res)
      raw.destroy()
      res.setHeader('content-type', 'text/plain')
      if (err.code === 'ENOENT') {
        res.statusCode = 404
        return res.end('Not found')
      }
      else if (err.code === 'EISDIR') {
        res.statusCode = 400
        return res.end('Bad request')
      }
      else {
        res.statusCode = 500
        return res.end('Ouch: ' + err.message)
      }
    }
    raw.once('error', err => {
      if (opts.debug) console.error('Read stream on read resource:', err)
      doErrorResponse(err)
    })
    res.once('error', err => {
      if (opts.debug) console.error('Response stream on read resource:', err)
      doErrorResponse(err)
    })
    raw.pipe(res)
  })
  server.once('error', err => {
    if (opts.debug) console.error('Remote server:', err)
    if (err.code != 'ENOENT') server.close()
  })
  // NOTE: when a host arg is given, there is a EADDRINUSE error.
  // It seems you can't get the choose-an-unused-port behavior unless you
  // don't specify the host.
  server.listen(/*'127.0.0.1',*/ () => {
    exports.stop = () => new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve())
    })
    console.log('Server address:', server.address())
    resolve(server.address().port)
  })
})

