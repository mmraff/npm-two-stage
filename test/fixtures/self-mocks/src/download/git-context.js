/*
  These functions are used by both fetch-remote-git and offliner.
  Borrowed and adapted from pacote/lib/util/git.js.
*/

exports.gitEnv = gitEnv
exports.mkOpts = mkOpts
//exports.getGitRepoDir = getGitRepoDir

//const { promisify } = require('util')
//const accessAsync = promisify(require('fs').access)
//const mkdirpAsync = promisify(require('mkdirp'))
const path = require('path')
//const which_sync = require('which').sync

const dirNames = {
  remotes: '_git-remotes',
  template: '_templates',
  offlineTemps: '_git-offline'
}
Object.freeze(dirNames)
exports.dirNames = dirNames

// We're mocking here, so we don't want git commands executed.
// Give the path to node instead of to git
exports.gitPath = process.execPath

let gitEnvMap

function gitEnv() {
  if (gitEnvMap) return gitEnvMap

  // allow users to override npm's insistence on not prompting for
  // passphrases, but default to just failing when credentials
  // aren't available
  gitEnvMap = {
    GIT_ASKPASS: 'echo'
  }
  return gitEnvMap
}

function mkOpts() { // here we don't care about args
  return {}
}

/*
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
*/