'use strict'

const path = require('path')

const log = require('npmlog')
const npa = require('npm-package-arg')

const DlTracker = require('./download/dltracker')
const gitAux = require('./download/git-aux')
const gitOffline = require('./git-offline')
const npm = require('./npm')

function validateArgs(dep, opts, next) {
  const depMsg = 'First argument must be the result of a call to npm-package-arg'
  const cbMsg = 'Third argument must be a callback function'

  if (dep === undefined || dep === null)
    throw new SyntaxError(depMsg)
  if (typeof dep != 'object' || typeof dep.type != 'string')
    throw new TypeError(depMsg)
  if (opts !== undefined && opts !== null) {
    if (typeof opts != 'object')
      throw new TypeError('If given, second argument must be an object')
  }
  if (next === undefined || next === null)
    throw new SyntaxError(cbMsg)
  if (typeof next != 'function')
    throw new TypeError(cbMsg)
}

module.exports = function offliner(dep, opts, next) {
  validateArgs(dep, opts, next)

  if (dep.type === 'tag' && dep.fetchSpec === 'latest') {
    // Easier to work with:
    dep.fetchSpec = '*'
    dep.type = 'range'
  }
  const dlType = DlTracker.typeMap[dep.type]
  if (!dlType) {
    return next(
      new Error('Offliner unhandled spec type "' + dep.type + '" ' + dep.raw)
    )
  }

  log.verbose('offliner', 'Looking locally for package to satisfy %s', dep.raw)

  let dlData, dep2

  // NOTE: the try/catches will no longer be necessary in a Promise-based version
  if (dep.type != 'git') {
    try { dlData = npm.dlTracker.getData(dlType, dep.name, dep.fetchSpec) }
    catch (err) {}
    if (dlData) {
      log.verbose('offliner', 'Found %s', dlData.filename)
      dep2 = npa(path.join(npm.dlTracker.path, dlData.filename))
    }
  }
  else {
    const trackerKeys = gitAux.trackerKeys(dep)
    try { dlData = npm.dlTracker.getData('git', trackerKeys.repo, trackerKeys.spec) }
    catch (err) {}
    if (!dlData) { // There still may be a legacy entry...
      try { dlData = npm.dlTracker.getData('git', null, dep.rawSpec) }
      catch (err) {}
    }
    if (dlData) {
      log.verbose('offliner', `Found git repo ${dlData.repo || dlData.from}`)
      if (dlData.filename)
        dep2 = npa(path.join(npm.dlTracker.path, dlData.filename))
      else {
        // In 1st version of dlTracker, type 'git' dlData has no filename
        // property; instead, we're working with a subdirectory.
        return gitOffline(dep, dlData, opts, next)
      }
    }
  }
  if (!dlData)
    return next(new Error(`Download Tracker knows nothing about ${dep.raw}`))

  next(null, dep2)
}

