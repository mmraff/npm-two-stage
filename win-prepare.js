var fs = require('fs')
var os = require('os')
var path = require('path')
var execSync = require('child_process').execSync

if (os.platform() !== 'win32') {
  console.error('ERROR: This script is intended for Windows platforms.')
  console.error('Please do not abuse it like this.')
  process.exit(1)
}

// WARNING: the files referenced in this script are specific to npm 2.x
var targets = {
  CHANGED_FILES: [ 'fetch-package-metadata', 'install', 'config\\cmd-list', 'install\\action\\refresh-package-json' ],
  ADDED_FILES: [ 'download', 'git-offline', 'offliner', 'prepare-raw-module' ],
  ADDED_DIRS: [ 'download' ]
}
module.exports.targets = targets

module.exports.backupFlag = '_ORIG'

var errCodes = {
  BAD_PROJECT: -9,
  NO_NPM_VER: -1,
  WRONG_NPM_VER: -2,
  BAD_NPM_INST: -3,
  LEFTOVERS: -4,
  FS_ACTION_FAIL: -5
}
module.exports.errorCodes = errCodes

module.exports.adviseUninstall = function() {
  console.error('The remains of a previous installation of npm-two-stage were found.')
  console.error('This complicates the current installation, so it will be aborted.')
  console.error('The best action to take now is to run\n  node win-uninstall.js')
  console.error('using the same npm-two-stage version as when the previous installation was done.')
}

var possibleRoots = []
var i, libStats, npmPath
var uniqueMap = {}

function doChecks(idx, next)
{
  var targetDir = path.join(possibleRoots[idx], 'lib')
  console.log('\n  Target directory is', targetDir, '\n')

  var expectedNpmVer
  try {
    expectedNpmVer = fs.readFileSync('./target-ver.txt', 'utf8')
      .trim()
  }
  catch (exc) {
    console.error('ERROR: Missing target version file!')
    process.exit(errCodes.BAD_PROJECT)
  }

  var npmVer
  try {
    npmVer = execSync('npm --version', { encoding: 'utf8' }).trim()
  }
  catch (exc) {
    console.error('ERROR: Could not get information from npm --version!')
    console.error(exc.stderr)
    process.exit(errCodes.NO_NPM_VER)
  }

  if (npmVer != expectedNpmVer) {
    console.log('ERROR: Wrong version of npm')
    process.exit(errCodes.WRONG_NPM_VER)
  }

  next(targetDir)
}

module.exports.init = function(next)
{
  if (!('Path' in process.env)) {
    console.log('ERROR: Environment has no "Path" variable! Aborting.')
    process.exit(1)
  }
  var matches = process.env.Path.match(/[^;]+nodejs[^;]*/g)
  if (matches) {
    // Remove duplicates
    for (i = 0; i < matches.length; i++) 
      if (!(matches[i] in uniqueMap)) uniqueMap[matches[i]] = true
    // Remaining: all the unique paths that contain 'nodejs'
    for (var p in uniqueMap) {
      if (path.basename(p) !== 'nodejs') continue
      npmPath = path.join(p, 'node_modules', 'npm')
      try {
        libStats = fs.statSync(path.join(npmPath, 'lib'))
      }
      catch (exc) {
        continue
      }
      if (!libStats.isDirectory()) continue
      possibleRoots.push(npmPath)
    }
  }

  uniqueMap = {}
  matches = process.env.Path.match(/[^;]+npm[^;]*/g)
  if (matches) {
    // Remove duplicates
    for (i = 0; i < matches.length; i++) 
      if (!(matches[i] in uniqueMap)) uniqueMap[matches[i]] = true
    // Remaining: all the unique paths that contain 'npm'
    for (npmPath in uniqueMap) {
      if (path.basename(npmPath) !== 'npm') continue
      try {
        libStats = fs.statSync(path.join(npmPath, 'lib'))
      }
      catch (exc) { continue }
      if (!libStats.isDirectory()) continue
      possibleRoots.push(npmPath)
    }
  }

  // Ensure there are no duplicates between the two subsets
  uniqueMap = {}
  for (i = 0; i < possibleRoots.length; i++) 
    if (!(possibleRoots[i] in uniqueMap)) uniqueMap[possibleRoots[i]] = true
  possibleRoots = Object.keys(uniqueMap)

  //console.log(possibleRoots) // DEBUG

  if (possibleRoots.length == 0) {
    console.error('Cannot find your npm installation.')
    console.error("If it's someplace weird, then this script won't work.")
    process.exit(BAD_NPM_INST)
  }
  if (possibleRoots.length == 1) {
    doChecks(0, next)
  }
  else {
    var rdln = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

    function showPathsMenu() {
      console.log()
      console.log('Your filesystem has more than one npm installation.')
      console.log('Please choose the one that you want to be two-staged.')
      console.log()
      for (var i = 0; i < possibleRoots.length; i++)
        console.log('%d : %s', i + 1, possibleRoots[i])
      console.log()
      rdln.question('Enter the number of your choice: ', function(input) {
        var n = input.trim()
        if (/^[1-9]\d*$/.test(n)) { // only accept positive integers
          n = parseInt(n)
          if (n <= possibleRoots.length) {
            rdln.close()
            return doChecks(n - 1, next)
          }
        }
        console.log('Invalid input.')
        showPathsMenu()
      })
    }

    showPathsMenu()
  }
}

