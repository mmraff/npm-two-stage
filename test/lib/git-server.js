/*
  Extracted/adapted from pacote v11.3.5 test/git.js
*/
const { spawn } = require('child_process')

let daemonPID

// port: ephemeral port on which the daemon should listen.
// base: path where repos and the cache are located.
exports.start = function startDaemon(port, base) {
  if (daemonPID) {
    return Promise.reject(new Error('git daemon already started'))
  }
  return new Promise((resolve, reject) => {
    let daemon
    try {
      daemon = spawn('git', [
        'daemon',
        `--port=${port}`,
        '--export-all',
        '--verbose',
        '--informative-errors',
        '--reuseaddr',
        '--base-path=.',
        '--listen=localhost',
      ], { cwd: base, stdio: [ 'pipe', 1, 'pipe' ] })
    }
    catch (err) { return reject(err) }
    const onDaemonData = c => {
      // we need the PID of the daemon to end it; it is emitted on startup
      const cpid = c.toString().match(/^\[(\d+)\]/)
      if (!cpid || !cpid[1]) return
      daemon.stderr.removeListener('data', onDaemonData)
      daemonPID = +cpid[1]
      exports.stop = () => new Promise((resolve, reject) => {
        if (!daemonPID)
          return reject(new Error('git daemon not running'))
        daemon.on('close', () => {
          daemonPID = undefined
          resolve()
        })
        try {
          process.kill(daemonPID)
        }
        catch (err) {
          // If we still have a PID, but the system can't find a running
          // process that has it, something must have killed it already
          // in a way that evaded the close event
          if (err.code === 'ESRCH') {
            daemonPID = undefined
            resolve()
          }
          else reject(err)
        }
      })
      resolve()
    }
    daemon.stderr.on('data', onDaemonData)
  })
}

