// These functions are used by both fetch-remote-git and offliner.

exports.gitEnv = gitEnv
exports.mkOpts = mkOpts
exports.getGitRepoDir = getGitRepoDir

const BB = require('bluebird')
const fs_access = BB.promisify(require('graceful-fs').access)
const mkdirp = BB.promisify(require('mkdirp'))
const path = require('path')
const which_sync = require('which').sync

const VALID_GIT_VARS = new Set([
  'GIT_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_PROXY_COMMAND',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSL_CAINFO',
  'GIT_SSL_NO_VERIFY'
])

const dirNames = {
  remotes: '_git-remotes',
  template: '_templates',
  offlineTemps: '_git-offline'
}
Object.freeze(dirNames)
exports.dirNames = dirNames

let defaultGitPath
try {
  defaultGitPath = which_sync('git')
}
catch (err) {}
exports.gitPath = defaultGitPath

let gitEnvMap

function gitEnv() {
  if (gitEnvMap) return gitEnvMap

  // allow users to override npm's insistence on not prompting for
  // passphrases, but default to just failing when credentials
  // aren't available
  gitEnvMap = {
    GIT_ASKPASS: 'echo'
  }

  for (let key in process.env) {
    if (!VALID_GIT_VARS.has(key) && key.match(/^GIT_/)) continue
    gitEnvMap[key] = process.env[key]
  }
  return gitEnvMap
}

function mkOpts(_gitOpts, opts) {
  const gitOpts = {
    env: gitEnv()
  }
  const isRoot = process.getuid && process.getuid() === 0
  // don't change child process uid/gid if not root
  if (+opts.uid && !isNaN(opts.uid) && isRoot) {
    gitOpts.uid = +opts.uid
  }
  if (+opts.gid && !isNaN(opts.gid) && isRoot) {
    gitOpts.gid = +opts.gid
  }
  Object.assign(gitOpts, _gitOpts)
  return gitOpts
}

// Returns a Promise
// NOTE: since this has the side effect of creating the remotes directory
// if it doesn't exist, it's really only useful in the download stage, and
// inappropriate for the offline stage.
// TODO: see if it can be modified to be useful in the offline stage!
function getGitRepoDir(basePath) {
  if (basePath === undefined || basePath === null || basePath === '')
    throw new SyntaxError('Must give location for git repos')
  if (typeof basePath !== 'string')
    throw new TypeError('Location for git repos must be given as a string')

  basePath = path.resolve(basePath)
  let remotes = path.join(basePath, dirNames.remotes)
  let templates = path.join(remotes, dirNames.template)

  // Require that basePath already exists
  return fs_access(basePath).then(() => {
    // We don't test whether the last component is a directory here,
    // because if it's not, mkdirp throws the correct error.

    // When passed a non-existent path that is creatable, mkdirp returns the
    // root of the created part of the path
    // When passed an existing path, mkdirp returns null.
    return mkdirp(templates)
  })
  .then(res => remotes)
}

