'use strict'

const Bluebird = require('bluebird')

const checkPlatform = Bluebird.promisify(require('npm-install-checks').checkPlatform)
const DlTracker = require('../../download/dltracker')
const getRequested = require('../get-requested.js')
const npm = require('../../npm.js')
const path = require('path')
const readJson = Bluebird.promisify(require('read-package-json'))
const updatePackageJson = Bluebird.promisify(require('../update-package-json'))

module.exports = function (staging, pkg, log) {
  log.silly('refresh-package-json', pkg.realpath)

  return readJson(path.join(pkg.path, 'package.json'), false).then((metadata) => {
    Object.keys(pkg.package).forEach(function (key) {
      if (key !== 'version' && key !== 'dependencies' && !isEmpty(pkg.package[key])) {
        metadata[key] = pkg.package[key]
      }
    })
    if (metadata._resolved == null && pkg.fakeChild) {
      metadata._resolved = pkg.fakeChild.resolved
    }
    // These two sneak in and it's awful
    delete metadata.readme
    delete metadata.readmeFilename

    pkg.package = metadata
    pkg.fakeChild = false
  }).catch(() => 'ignore').then(() => {
    return checkPlatform(pkg.package, npm.config.get('force'))
  }).then(() => {
    const requested = pkg.package._requested || getRequested(pkg)
    if (requested.type !== 'directory') {
      if (npm.config.get('offline')) {
        pkg.package._from = requested.raw
        pkg.package._spec = requested.raw
        const dlType = DlTracker.typeMap[requested.type]
        if (!dlType) {
          throw new Error(`Requested type ${requested.type} not recognized (package ${requested.raw}). HOW DID WE GET HERE?!`)
          // <MMR> Paradox: how did we get here if --offline?
          // Maybe we're guaranteed there's no need for this;
          // still, keep it for dev testing for now.
          // ANSWER: I have seen this come up when there's a package-lock.json
          // in the install dir, because, up until now, that records the local
          // file URL as the dependency spec.
          // BUT it seems that I solved that by changing the saveSpec below!
        }
        if (dlType != 'git') {
          const dlData = npm.dlTracker.getData(
            dlType, requested.name, requested.fetchSpec || requested.rawSpec
          )
          pkg.package._resolved = dlData._resolved
          pkg.saveSpec = requested.rawSpec
        }
        else {
          const dlData = npm.dlTracker.getData('git', null, requested.rawSpec)
          pkg.package._resolved =
            requested.saveSpec.replace(/(?:#.*)?$/, `#${dlData.resolvedTreeish}`)
        }
      }
      return updatePackageJson(pkg, pkg.path)
    }
  })
}

function isEmpty (value) {
  if (value == null) return true
  if (Array.isArray(value)) return !value.length
  if (typeof value === 'object') return !Object.keys(value).length
  return false
}
