// Loosely based on an extract from cache.js

module.exports = offliner

var npm = require('./npm.js')
  , log = require('npmlog')
  , fs = require('graceful-fs')
  , path = require('path')
  , semver = require('semver')
  , realizePackageSpecifier = require('realize-package-specifier')
  , fnameParser = require('./download/npm-package-filename.js')
  , gitOffline = require('./git-offline.js')

// Intended as a wrapper for the callback passed to realizePackageSpecifier
// in function add() in file cache.js.
// Pre-screens the parsed package spec p, and identifies the package in the
// offline location where otherwise the cache code would attempt to fetch
// from a remote repository if the spec is not explicitly local.
//
function offliner (next, done) {
  return function(err, p) {
    if (err) return done(err)

    // Thresh out the simple stuff here at the gate
    if (p.type === 'local' || p.type === 'directory')
      return next(done)(null, p)

    if (p.type === 'tag' && p.spec === 'latest') {
      // Easier to work with:
      p.spec = '*'
      p.type = 'range'
    }

    log.verbose('offliner', 'Looking locally for package to satisfy %s', p.raw)

    var dlData
    var typeMap = {
      version: 'semver',
      range: 'semver',
      tag: 'tag',
      remote: 'url',
      git: 'git',
      hosted: 'git'
    }
    var type = typeMap[p.type]
    if (!type) 
      return done(new Error('Offliner unhandled spec type "' + p.type + '" ' + p.raw))

    switch (p.type) {
      // Cases 'local' and 'directory' are already shunted above
      case 'version':
      case 'range':
      case 'tag':
      case 'remote':
        dlData = npm.dlTracker.getData(type, p.name, p.spec)
        if (!dlData) break
        log.verbose('offliner', 'Found %s', dlData.filename)
        var tgzPath = path.join(npm.dlTracker.path, dlData.filename)

        // convince addLocal that the checkout is a local dependency
        return realizePackageSpecifier(tgzPath, function (rpsErr, specData) {
          if (rpsErr) {
            log.error('offliner', 'Failed to map', tgzPath, 'to a package specifier')
            done(rpsErr)
          }
          return next(moreAfterAdd)(null, specData)

          function moreAfterAdd (er, data) {
            if (data) {
              // If the tracker had to reconstruct the semver data map because
              // the dltracker.json file got lost, dlData will not have the
              // following fields
              if (dlData._from) data._from = dlData._from
              if (dlData._resolved) data._resolved = dlData._resolved
              if (!data._shasum) data._shasum = dlData._shasum // TODO: check into this
            }
            done(er, data)
          }
        })

      case 'git':
      case 'hosted':
        dlData = npm.dlTracker.getData('git', null, p.rawSpec)
        if (!dlData) break
        return gitOffline(dlData, next, done)
    }

    return done(new Error('Tracker knows nothing about ' + p.raw))
  }
}

