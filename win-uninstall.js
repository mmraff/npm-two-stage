var execSync = require('child_process').execSync
var fs = require('fs')
var path = require('path')
var prep = require('./win-prepare.js')
var TGTS = prep.targets
var BAKFLAG = prep.backupFlag
var ERRS = prep.errorCodes

// The uninstall process is more forgiving than install, because it might need
// to be used to clean up after a partially failed installation.

prep.init(function(targetDir) {
  if (typeof targetDir !== 'string') {
    console.error('Bad argument to win-prepare.init callback:', targetDir)
    process.exit(1)
  }
  var i, fname, tgtPrefix, delResult, bsIdx

// * execSync('del FILE') *does not* throw an error when access is denied!?!
// * execSync('del FILE') does not throw when FILE does not exist;
//  exact message prefix is "Could Not Find "
// * execSync('rename FILE OTHERNAME') *does* throw an error when access is denied.
// TODO: write a test script to execute on Windows XP to see if behavior is the same as above.

  for (i = 0; i < TGTS.CHANGED_FILES.length; i++) {
    fname = TGTS.CHANGED_FILES[i]
    tgtPrefix = path.join(targetDir, fname)
    try {
      stats = fs.statSync(tgtPrefix + BAKFLAG + '.js')
    }
    catch (exc) {
      if (exc.code === 'ENOENT') {
        console.warn('WARNING: No backup of ' + fname + '.js found in target location')
        // Do not delete the supposed replacement file -
        // it might be the original!
        continue
      }
//console.error(exc) // DEBUG ONLY
      // else... why would stat() fail?
    }

    console.log('  Removing ' + fname + '.js from target location...')
    // Strangely, erroneous exec('del') does not yield an error object or throw
    // an exception; the only clue that something's wrong is in the stderr,
    // which we can only get by special redirection tricks.
    var delResult = execSync(
      'del "' + tgtPrefix + '.js" 2>&1 >NUL', { encoding: 'utf8' }
    ).trim()
    if (delResult === 'Access is denied.') {
      console.error('ERROR:', delResult, 'Aborting uninstall.')
      process.exit(ERRS.FS_ACTION_FAIL)
    }
    if (delResult.search(/Could Not Find /i) == 0) {
      console.warn('WARNING: No ' + fname + '.js found in target location.')
    }

    // Special treatment for files in official npm subdirectories:
    bsIdx = fname.lastIndexOf('\\')
    if (bsIdx !== -1)
      fname = fname.substr(bsIdx + 1)

    console.log('  Renaming', fname + BAKFLAG + '.js', 'to', fname + '.js',
      'in target location...')
    try {
      execSync(['rename "', tgtPrefix, BAKFLAG, '.js" ', fname, '.js'].join(''))
    }
    catch (exc) {
      console.error('ERROR: Failed to rename', fname + BAKFLAG + '.js')
//console.error(exc) // DEBUG ONLY
      process.exit(ERRS.FS_ACTION_FAIL)
    }
  }

  for (i = 0; i < TGTS.ADDED_FILES.length; i++) {
    fname = TGTS.ADDED_FILES[i]
    tgtPrefix = path.join(targetDir, fname)

    console.log('  Removing ' + fname + '.js from target location...')
    delResult = execSync(
      'del "' + tgtPrefix + '.js" 2>&1 >NUL', { encoding: 'utf8' }
    ).trim()
    if (delResult === 'Access is denied.') {
      console.error('ERROR:', delResult, 'Aborting uninstall.')
      process.exit(ERRS.FS_ACTION_FAIL)
    }
    if (delResult.search(/Could Not Find /i) == 0) {
      console.warn('WARNING: No ' + fname + '.js found in target location.')
    }
  }

  for (i = 0; i < TGTS.ADDED_DIRS.length; i++) {
    fname = TGTS.ADDED_DIRS[i]
    tgtPrefix = path.join(targetDir, fname) // It's the full path in this case

    console.log('  Removing folder', fname, 'from target location...')
    try {
      execSync('rmdir /s /q "' + tgtPrefix + '"', {encoding: 'utf8'})
    }
    catch (exc) {
      if (exc.stderr.search(/cannot find /i) != -1) {
        console.warn('WARNING: No', fname, 'folder found in target location.')
      }
      else {
        console.error('ERROR:', exc.stderr.trim())
        process.exit(ERRS.FS_ACTION_FAIL)
      }
    }
  }

  console.log('\n  Uninstallation of npm-two-stage was successful.\n')
})

