/*
  TODO:
  * Add emitter.emit with messages at each step
*/

const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const execAsync = promisify(require('child_process').exec)
const readdirAsync = promisify(fs.readdir)
const rmdirAsync = promisify(fs.rmdir)
const unlinkAsync = promisify(fs.unlink)

const {
  targets: TGTS,
  backupFlag: BAKFLAG,
  errorCodes: ERRS
} = require('./constants')

const {
  emitter,
  expectCorrectNpmVersion,
  removeAddedItems,
  restoreBackups
} = require('./shared')

module.exports.uninstallProgress = emitter

/*
  Specifying the npm root path is an alternative that allows the user to
  restore a different npm installation than the one that is active on the
  current system; for example, one on a USB drive that the user intended
  to use on another platform.
*/
module.exports.uninstall = function(npmDir) {
  const startDir = process.cwd()
  if (npmDir) npmDir = path.resolve(path.normalize(npmDir))
  emitter.emit('msg',
    `Checking npm version ${npmDir ? 'at given path' : '(live)'}...`
  )
  return expectCorrectNpmVersion(npmDir)
  .then(() => npmDir ||
    execAsync('npm root -g').then(({ stdout }, stderr) =>
      npmDir = path.join(stdout.trim(), 'npm')
    )
  )
  .then(() => {
    emitter.emit('msg', `Target npm home is ${npmDir}`)
    process.chdir(path.join(npmDir, 'lib'))
    emitter.emit('msg', 'Removing items added by npm-two-stage install...')
    return removeAddedItems()
  })
  .then(() => {
    emitter.emit('msg', 'Restoring backed-up original files...')
    return restoreBackups()
  })
  .then(() => process.chdir(startDir))
  .catch(err => {
    // There is no Promise.prototype.finally() until node.js v10.0.0
    process.chdir(startDir)
    throw err
  })
}
