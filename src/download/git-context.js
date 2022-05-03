/*
  These functions are used by both fetch-remote-git and offliner.
  Borrowed and adapted from pacote/lib/util/git.js.
*/

exports.gitEnv = gitEnv
exports.mkOpts = mkOpts
exports.getGitRepoDir = getGitRepoDir

const { promisify } = require('util')
const accessAsync = promisify(require('fs').access)
const mkdirpAsync = promisify(require('mkdirp'))
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

function getGitRepoDir(basePath) {
  if (basePath === undefined || basePath === null || basePath === '')
    return BB.reject(new SyntaxError('Must give location for git repos'))
  if (typeof basePath !== 'string')
    return BB.reject(new TypeError('Location for git repos must be given as a string'))

  basePath = path.resolve(basePath)
  let remotes = path.join(basePath, dirNames.remotes)
  let templates = path.join(remotes, dirNames.template)

  // Require that basePath already exists
  return accessAsync(basePath)
  // We don't test whether the last component is a directory here,
  // because if it's not, mkdirp throws the correct error.
  .then(() => mkdirpAsync(templates)).then(res => remotes)
}

