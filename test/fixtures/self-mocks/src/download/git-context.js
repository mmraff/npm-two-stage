module.exports.gitEnv = gitEnv
module.exports.mkOpts = mkOpts

const path = require('path')

const dirNames = {
  remotes: '_git-remotes',
  template: '_templates',
  offlineTemps: '_git-offline'
}
Object.freeze(dirNames)
module.exports.dirNames = dirNames

// We're mocking here, so we don't want git commands executed.
// Give the path to node instead of to git
module.exports.gitPath = process.execPath

let gitEnvMap

function gitEnv() {
  if (gitEnvMap) return gitEnvMap

  gitEnvMap = {
    GIT_ASKPASS: 'echo'
  }
  return gitEnvMap
}

function mkOpts() { // here we don't care about args
  return {}
}
