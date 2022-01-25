'use strict'

const Bluebird = require('bluebird')

const checkPlatform = Bluebird.promisify(require('npm-install-checks').checkPlatform)
const DlTracker = require('../../download/dltracker')
const getRequested = require('../get-requested.js')
const gitAux = require('../../download/git-aux')
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
          throw new Error([
            'Requested type ', requested.type,
            ' not recognized (package ', requested.raw,
            '). HOW DID WE GET HERE?!'
          ].join(''))
        }
        if (dlType != 'git') {
          const dlData = npm.dlTracker.getData(
            dlType, requested.name, requested.fetchSpec || requested.rawSpec
          )
          pkg.package._resolved = dlData._resolved
          pkg.saveSpec = requested.rawSpec
        }
        else {
          const trackerKeys = gitAux.trackerKeys(requested)
          const dlData =
            npm.dlTracker.getData('git', trackerKeys.repo, trackerKeys.spec) ||
            npm.dlTracker.getData('git', null, requested.rawSpec) // legacy
          pkg.package._resolved = requested.saveSpec.replace(
            /(?:#.*)?$/, `#${dlData.commit || dlData.resolvedTreeish}`
          )
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
