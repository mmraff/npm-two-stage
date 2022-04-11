const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const accessAsync = promisify(fs.access)
const copyFileAsync = promisify(fs.copyFile) // copyFile added in v8.5.0.
const execAsync = promisify(require('child_process').exec)
const readdirAsync = promisify(fs.readdir)
const renameAsync = promisify(fs.rename)
const { COPYFILE_EXCL } = fs.constants

const { graft } = require('./file-tools')

const {
  targetVersion: EXPECTED_NPM_VER,
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

module.exports.installProgress = emitter

/*
  RE: "Deep New Files"...
  Historically, this project has created new directories (e.g., download/)
  as well as new files in npm/lib/.
  We have never created, and will never need (crossing fingers) to create
  new directories deeper than in npm/lib/.
  We haven't yet, but may still, create new files in existing directories
  deeper than in npm/lib/; it depends on future mutations of the npm cli.

  This function expects to operate on the current directory.
*/
function expectNoLeftovers() {
  const bakSuffix = BAKFLAG + '.js'
  const topNewFiles =
    TGTS.ADDED_FILES.filter(f => !f.includes('/'))
    .map(f => f + '.js')
  const deepNewFiles =
    TGTS.ADDED_FILES.filter(f => f.includes('/'))
    .map(f => path.normalize(f) + '.js')
  const existingDirs =
    TGTS.CHANGED_FILES.filter(f => f.includes('/'))
    .map(f => path.dirname(path.normalize(f)))
  existingDirs.unshift('.') // Start with npm/lib/

  function expectDeepNewFilesAbsent(i) {
    if (i >= deepNewFiles.length) return Promise.resolve()
    const item = deepNewFiles[i]
    return accessAsync(item).then(() => {
      throw getLeftoversError(item)
    })
    .catch(err => {
      if (err.exitcode) throw err
      // else it *probably* doesn't exist, which would be good.
      return expectDeepNewFilesAbsent(i+1)
    })
  }

  function expectNoOldBackups(i) {
    if (i >= existingDirs.length) return Promise.resolve()
    return readdirAsync(existingDirs[i]).then(entryList => {
      for (let f of entryList)
        if (f.endsWith(bakSuffix)) {
          const err = new Error(`old backup ${f} in target location`)
          err.exitcode = ERRS.LEFTOVERS
          throw err
        }
      return expectNoOldBackups(i+1)
    })
  }

  return readdirAsync('.').then(entryList => {
    const newItems = topNewFiles.concat(TGTS.ADDED_DIRS)
    for (let item of newItems)
      if (entryList.includes(item))
        throw getLeftoversError(item)
  })
  .then(() => expectNoOldBackups(0))
  .then(() => expectDeepNewFilesAbsent(0))
}

function getLeftoversError(item) {
  const err = new Error([
    'evidence of previous npm-two-stage installation',
    `(${item})`,
    'in target location'
  ].join(' '))
  err.exitcode = ERRS.LEFTOVERS
  return err
}

/*
  This function expects the paths on the given list to be sufficient
  for locating the files, even if they are relative.
*/
function changeToBackupNames(nameList) {
  const successes = []
  function backUpOldFiles(i) {
    if (i >= nameList.length) return Promise.resolve()
    const oldName = nameList[i]
    // Must use path.normalize() because any of the given items may contain
    // posix path separators (e.g. 'util/cmd-list'):
    const backupName = path.normalize(`${oldName}${BAKFLAG}.js`)
    return renameAsync(path.normalize(oldName + '.js'), backupName)
    .then(() => {
      successes.push(oldName)
      return backUpOldFiles(i+1)
    })
  }
  function restoreOldFiles(i) {
    if (i >= successes.length) return Promise.resolve()
    const oldName = successes[i]
    const backupName = path.normalize(`${oldName}${BAKFLAG}.js`)
    return renameAsync(backupName, path.normalize(oldName + '.js'))
    .then(() => restoreOldFiles(i+1))
  }

  return backUpOldFiles(0).catch(err => {
    emitter.emit('msg', 'Error while renaming files; restoring original names...')
    return restoreOldFiles(0).then(() => {
      err.exitcode = ERRS.FS_ACTION_FAIL
      throw err
    })
  })
}

/*
  cp case: a list of regular files to copy to a directory.
  * assume that each item on the list is a path relative to current directory
  * preserve the relative path in dest copy
  * assume that any directory components in each item already exist in dest
  * reject if file already exists at dest
*/
function copyFilesFromCWD(list, dest) {
  function nextItem(i) {
    if (i >= list.length) return Promise.resolve()
    const item = list[i]
    return copyFileAsync(item, path.join(dest, item), COPYFILE_EXCL)
    .then(() => nextItem(i+1))
  }
  return nextItem(0)
}

function copyDirsFromCWD(list, dest) {
  function nextDir(i) {
    if (i >= list.length) return Promise.resolve()
    return graft(list[i], dest)
    .then(() => nextDir(i+1))
  }
  return nextDir(0)
}


/*
  Specifying the npm root path is an alternative that allows the user to
  install over a different npm installation than the one that is active
  on the current system; for example, an npm installed on a USB drive that
  the user intends to use on another platform.
*/
module.exports.install = function(npmDir) {
  const startDir = process.cwd()
  const srcDir = path.join(path.dirname(__dirname), 'src') // lib/../src
  let backupAccomplished = false
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
    return expectNoLeftovers()
  })
  .then(() => {
    const files = TGTS.CHANGED_FILES.map(f => path.resolve(f) + '.js')
    emitter.emit('msg',
      `Backing up files to be replaced: ${files.join(', ')} ...`
    )
    return changeToBackupNames(TGTS.CHANGED_FILES)
  })
  .then(() => {
    const files = TGTS.CHANGED_FILES.concat(TGTS.ADDED_FILES)
      .map(f => path.normalize(f + '.js'))
    const itemsToCopy = files.concat(TGTS.ADDED_DIRS)
    emitter.emit('msg',
      `Copying into target directory: ${itemsToCopy.join(', ')} ...`
    )
    process.chdir(srcDir)
    const dest = path.join(npmDir, 'lib')
    return copyFilesFromCWD(files, dest)
    .then(() => copyDirsFromCWD(TGTS.ADDED_DIRS, dest))
    .then(() => process.chdir(startDir))
    .catch(err => {
      // Clean up should not throw
      // (If it does, then we have a truly hostile environment!)
      process.chdir(dest)
      return removeAddedItems()
      .then(() => restoreBackups())
      .then(() => {
        err.exitcode = ERRS.FS_ACTION_FAIL
        throw err
      })
    })
  })
  .catch(err => {
    process.chdir(startDir)
    throw err
  })
}
