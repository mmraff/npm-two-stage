var execSync = require('child_process').execSync
var fs = require('fs')
var path = require('path')
var prep = require('./win-prepare.js')
var TGTS = prep.targets
var BAKFLAG = prep.backupFlag
var ERRS = prep.errorCodes

prep.init(function(targetDir) {
  var targetDirQtd = '"' + targetDir + '"'
  var i, fname, srcPath, destPath, destPathQtd, backupName, bsIdx

  for (i = 0; i < TGTS.CHANGED_FILES.length; i++) {
    fname = TGTS.CHANGED_FILES[i]
    destPath = path.join(targetDir, fname) + '.js'
    destPathQtd = '"' + destPath + '"'
    backupName = fname + BAKFLAG + '.js'

    try {
      fs.statSync(path.join(targetDir, backupName))
      // If we get here, there is a leftover from a previous install. Not good.
      console.error('ERROR: Found an old ' + backupName + ' in target location')
      adviseUninstall()
      process.exit(ERRS.LEFTOVERS)
    }
    catch (exc) {} // Does not exist, most likely. Good.

    // Special treatment for files in official npm subdirectories:
    bsIdx = fname.lastIndexOf('\\')
    if (bsIdx !== -1)
      backupName = backupName.substr(bsIdx + 1)

    console.log('  Renaming', fname + '.js', 'to', backupName, 'in target location...')
    try {
      execSync([ 'rename', destPathQtd, backupName ].join(' '))
    }
    catch (exc) {
      console.error('ERROR: Failed to rename', fname + '.js')
      process.exit(ERRS.FS_ACTION_FAIL)
    }

    srcPath = path.join('src', fname + '.js')
    console.log('  Copying', srcPath, 'into target location...')
    try {
      execSync([ 'copy', srcPath, destPathQtd ].join(' '))
    }
    catch (exc) {
      console.error('ERROR: Failed to copy', srcPath, 'into', targetDir)
      process.exit(ERRS.FS_ACTION_FAIL)
    }
  }

  for (i = 0; i < TGTS.ADDED_FILES.length; i++) {
    fname = TGTS.ADDED_FILES[i]
    srcPath = path.join('src', fname + '.js')

    try {
      fs.statSync(path.join(targetDir, fname + '.js'))
      // If we get here, there is a leftover from a previous install. Not good.
      console.error('ERROR: Found an old ' + fname + '.js in target location')
      adviseUninstall()
      process.exit(ERRS.LEFTOVERS)
    }
    catch (exc) {} // Does not exist, most likely. Good.

    console.log('  Copying', srcPath, 'into target location...')
    try {
      execSync([ 'copy', srcPath, targetDirQtd ].join(' '))
    }
    catch (exc) {
      console.error('ERROR: Failed to copy', srcPath, 'into', targetDir)
      process.exit(ERRS.FS_ACTION_FAIL)
    }
  }

  for (i = 0; i < TGTS.ADDED_DIRS.length; i++) {
    fname = TGTS.ADDED_DIRS[i]
    srcPath = path.join('src', fname)
    destPath = path.join(targetDir, fname)

    try {
      var destStats = fs.statSync(destPath)
      // If we get this far, we have leftovers from previous install.
      console.error('ERROR: Found old "' + fname + '" folder in target location')
      adviseUninstall()
      process.exit(ERRS.LEFTOVERS)
    } catch (exc) {} // Does not exist, most likely. Good.

    console.log('  Copying directory', srcPath, 'into target location...')
    try {
      execSync([ 'xcopy', srcPath, '"' + destPath + '"', '/i /s /q' ].join(' '))
    }
    catch (exc) {
      console.error('ERROR: Failed to copy', srcPath, 'into', targetDir)
      process.exit(ERRS.FS_ACTION_FAIL)
    }
  }

  console.log('\n  Installation of npm-two-stage was successful.\n')
})

