// These functions are used by both fetch-remote-git and offliner.
// Contents appropriated from cache/add-remote-git.js

exports.gitEnv = gitEnv
exports.getGitDir = getGitDir
exports.remotesDirName = remotesDirName
exports.templateDirName = templateDirName

var assert = require('assert')
var mkdir = require('mkdirp')
var fs = require('graceful-fs')
var path = require('path')
var correctMkdir = require('../utils/correct-mkdir.js')

var VALID_VARIABLES = [
  'GIT_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_PROXY_COMMAND',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSL_CAINFO',
  'GIT_SSL_NO_VERIFY'
]

var dirNames = {
  remotes: '_git-remotes',
  template: '_templates'
}
function remotesDirName () {
  return dirNames.remotes
}
function templateDirName () {
  return dirNames.template
}

var gitEnv_
function gitEnv () {
  // git responds to env vars in some weird ways in post-receive hooks
  // so don't carry those along.
  if (gitEnv_) return gitEnv_

  // allow users to override npm's insistence on not prompting for
  // passphrases, but default to just failing when credentials
  // aren't available
  gitEnv_ = { GIT_ASKPASS: 'echo' }

  for (var k in process.env) {
    if (!~VALID_VARIABLES.indexOf(k) && k.match(/^GIT/)) continue
    gitEnv_[k] = process.env[k]
  }
  return gitEnv_
}

function getGitDir (basePath, cb) {
  assert(basePath && typeof basePath === 'string', 'Must have base path')

  var remotes = path.resolve(basePath, dirNames.remotes)
  var templates = path.join(remotes, dirNames.template)
  
  correctMkdir(remotes, function (er, stats) {
    if (er) return cb(er)

    // We don't need global templates when cloning. Use an empty directory for
    // the templates, creating it (and setting its permissions) if necessary.
    mkdir(templates, function (er) {
      if (er) return cb(er)

      // Ensure that both the template and remotes directories have the correct
      // permissions.
      fs.chown(templates, stats.uid, stats.gid, function (er) {
        cb(er, stats)
      })
    })
  })
}

