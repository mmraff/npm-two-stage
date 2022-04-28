/*
  WARNING: the files named in this script are specific to the
  referenced version of npm:
*/
module.exports.targetVersion = '6.13.4'

module.exports.targets = Object.freeze({
  CHANGED_FILES:
    Object.freeze([ 'fetch-package-metadata', 'install', 'config/cmd-list', 'install/action/refresh-package-json' ]),
  ADDED_FILES:
    Object.freeze([ 'download', 'git-offline', 'offliner', 'prepare-raw-module' ]),
  ADDED_DIRS:
    Object.freeze([ 'download' ])
})

module.exports.backupFlag = '_ORIG'

module.exports.errorCodes = Object.freeze({
  BAD_PROJECT: -9,
  NO_NPM: -1,
  WRONG_NPM_VER: -2,
  BAD_NPM_INST: -3,
  LEFTOVERS: -4,
  FS_ACTION_FAIL: -5
})

Object.freeze(module.exports)
