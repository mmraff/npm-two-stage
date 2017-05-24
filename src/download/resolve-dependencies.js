// Based on readDependencies in install.js (npm 2.15)
// install.js was completely refactored for npm 3,
// so this code can't track that anymore.

module.exports = resolveDependencies

var log = require("npmlog")
  , url = require("url")

function resolveDependencies (pkgData, opts, cb) {
  var wrap = opts ? opts.wrap : null
  var newwrap = opts ? opts.newwrap : null
  var rv = {}

  if (opts && opts.dev) {
    if (!pkgData.dependencies) pkgData.dependencies = {}
    Object.keys(pkgData.devDependencies || {}).forEach(function (k) {
      if (pkgData.dependencies[k]) {
        log.warn("package.json", "Dependency '%s' exists in both dependencies " +
                 "and devDependencies, using '%s@%s' from dependencies",
                  k, k, pkgData.dependencies[k])
      } else {
        pkgData.dependencies[k] = pkgData.devDependencies[k]
      }
    })
  }

  // From https://docs.npmjs.com/files/package.json:
  // "Entries in optionalDependencies will override entries of the same
  // name in dependencies, so it's usually best to only put in one place."
  // But sometimes people put them in both places. Here they are removed
  // from dependencies if the user has opted out.
  if (!(opts && opts.optional) && pkgData.optionalDependencies) {
    Object.keys(pkgData.optionalDependencies).forEach(function (d) {
      delete pkgData.dependencies[d]
    })
  }

  if (opts && opts.useShrinkwrap === false) {
    // User has opted out of shrinkwraps entirely
    return cb(null, pkgData, null)
  }

  if (wrap) {
    log.verbose("resolveDependencies: using existing wrap", wrap)
    Object.keys(pkgData).forEach(function (key) {
      rv[key] = pkgData[key]
    })
    rv.dependencies = {}
    Object.keys(wrap).forEach(function (key) {
      log.verbose("from wrap", [key, wrap[key]])
      rv.dependencies[key] = readWrap(wrap[key])
    })
    log.verbose("resolveDependencies returned deps", rv.dependencies)
    return cb(null, rv, wrap)
  }

  if (!newwrap) return cb(null, pkgData, null)

  log.verbose("resolveDependencies", "npm-shrinkwrap.json is overriding dependencies")
  Object.keys(pkgData).forEach(function (key) {
    rv[key] = pkgData[key]
  })
  rv.dependencies = {}
  Object.keys(newwrap.dependencies || {}).forEach(function (key) {
    rv.dependencies[key] = readWrap(newwrap.dependencies[key])
  })

  // fold in devDependencies if not already present, at top level
  if (opts && opts.dev) {
    Object.keys(pkgData.devDependencies || {}).forEach(function (k) {
      rv.dependencies[k] = rv.dependencies[k] || pkgData.devDependencies[k]
    })
  }

  log.verbose("resolveDependencies returned deps", rv.dependencies)
  return cb(null, rv, newwrap.dependencies)
}

function readWrap (w)
{
  return (w.resolved) ? w.resolved
       : (w.from && url.parse(w.from).protocol) ? w.from
       : w.version
}

