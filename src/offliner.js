'use strict'

const assert = require('assert');
const path = require('path')

const log = require('npmlog')
const npa = require('npm-package-arg')

const DlTracker = require('./download/dltracker')
const gitOffline = require('./git-offline')
const npm = require('./npm')

module.exports = function offliner(dep, opts, next) {
  assert(
    dep && typeof dep == 'object' && !!dep.type,
    'First argument should be the result of a call to npm-package-arg'
  )
  assert(
    dep.type != 'file' && dep.type != 'directory',
    `package type '${dep.type}' should not be passed to this`
  )
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

  if (dep.type != 'git') {
    dlData = npm.dlTracker.getData(dlType, dep.name, dep.fetchSpec)
    if (dlData) {
      log.verbose('offliner', 'Found %s', dlData.filename)
      dep2 = npa(path.join(npm.dlTracker.path, dlData.filename))
    }
  }
  else {
    //log.verbose('offliner', 'What npa thinks of a git spec:', dep)
    dlData = npm.dlTracker.getData('git', null, dep.rawSpec)
    if (dlData) {
      log.verbose('offliner', `Found git repo ${dlData.from}`)
      if (dlData.filename) {
        dep2 = npa(path.join(npm.dlTracker.path, dlData.filename))
      }
      else {
        // In 1st version of dlTracker, type 'git' dlData has no filename
        // property; instead, we're working with a subdirectory.
        return gitOffline(dep, dlData, opts, next)
        //
        // LATER DISCOVERY: In answer to "why bother with the cache?", we have
        // this from pacote/extract.js:
        //   if (spec.type === 'git' && !opts.cache) {
        //     throw new TypeError('Extracting git packages requires a cache folder')
        //   }
        // So it looks like we will have to dodge pacote.extract, and write a
        // modified version of that code that uses a tmp dir.
      }
    }
  }
  if (!dlData)
    return next(new Error('DLTracker knows nothing about ' + dep.raw))

  next(null, dep2)
}

