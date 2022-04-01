/*
  WARNING: the files named in this script are specific to the
  referenced version of npm:
*/
module.exports.targetVersion = '7.24.0'

module.exports.targets = Object.freeze({
  CHANGED_FILES:
    Object.freeze([ 'install', 'utils/cmd-list', 'utils/config/definitions' ]),
  ADDED_FILES:
    Object.freeze([ 'download' ]),
  ADDED_DIRS:
    Object.freeze([ 'download', 'offliner' ])
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
