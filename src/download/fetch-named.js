var path = require('path')
var assert = require('assert')
var http = require('http')
var log = require('npmlog')
var semver = require('semver')
var url = require('url')
var npm = require('../npm.js')
var deprCheck = require('../utils/depr-check.js')
var inflight = require('inflight')
var fetchRemoteTarball = require('./fetch-remote-tarball.js')
var mapToRegistry = require('../utils/map-to-registry.js')
var pulseTillDone = require('../utils/pulse-till-done.js')
var packageId = require('../utils/package-id.js')
var pickManifestFromRegistryMetadata = require('../utils/pick-manifest-from-registry-metadata.js')

module.exports = fetchNamed

function getOnceFromRegistry (name, from, next, done) {
  function fixName(err, data, json, resp) {
    // this is only necessary until npm/npm-registry-client#80 is fixed
    if (err && err.pkgid && err.pkgid !== name) {
      err.message = err.message.replace(
        new RegExp(': ' + err.pkgid.replace(/(\W)/g, '\\$1') + '$'),
        ': ' + name
      )
      err.pkgid = name
    }
    next(err, data, json, resp)
  }

  mapToRegistry(name, npm.config, function (er, uri, auth) {
    if (er) return done(er)

    var key = 'registry:' + uri
    next = inflight(key, next)
    if (!next) return log.verbose(from, key, 'already in flight; waiting')
    else log.verbose(from, key, 'not in flight; fetching')

    npm.registry.get(uri, { auth: auth }, pulseTillDone('fetchRegistry', fixName))
  })
}

// NOTE: target arg is *not* the same object passed to afterDl, but created inline
// in the call to this function; fields 'name' and 'spec'.
function fetchNamed (target, pkgData, cb_) {
  assert(target && typeof target == 'object', 'must have module target')
  assert(target.name && typeof target.name == 'string',
         'target must include module name')
  assert(typeof cb_ == 'function', 'must have callback')

  var name = target.name
  var spec = target.spec
  var validVer = semver.valid(spec)
  var validVerLoose = semver.valid(spec, true)
  var stringified = JSON.stringify(spec)
  var key = name + '@' + spec

  log.silly('fetchNamed', key)

  if (validVer && npm.dlTracker.contains('semver', name, spec)) {
    var results = { name: name, spec: spec, _duplicate: true }
    return cb_(null, results)
  }

  function cb (er, results, pkgData, wrapData) {
    if (results && !results._fromHosted) results._from = key
    cb_(er, results, pkgData, wrapData)
  }

  if (validVerLoose) {
    log.verbose('fetchNamed', stringified, 'is a plain semver version for', name)
    fetchNameVersion(target, pkgData, cb)
  }
  else if (semver.validRange(spec, true)) {
    log.verbose('fetchNamed', stringified, 'is a valid semver range for', name)
    fetchNameRange(target, pkgData, cb)
  }
  else {
    log.verbose('fetchNamed', stringified, 'is being treated as a dist-tag for', name)
    fetchNameTag(target, pkgData, cb)
  }
}

function fetchNameTag (target, data, cb) {
  log.info('fetchNameTag', [target.name, target.spec])
  var explicit = true

  target.tag = target.spec
  if (!target.tag) { // as in spec === ''
    explicit = false
    target.tag = npm.config.get('tag') // default is 'latest'
  }
  if (target.tag !== 'latest'
      && npm.dlTracker.contains('tag', target.name, target.tag)) {
    var result = {
      name: target.name,
      spec: target.spec,
      tag: target.tag,
      _duplicate: true
    }
    return cb(null, result)
  }

  getOnceFromRegistry(target.name, 'fetchNameTag', next, cb)

  function next (er, regData, json, resp) {
    if (!er) er = errorResponse(target.name, resp)
    if (er) return cb(er)

    log.silly('fetchNameTag', 'next for', target.name, 'with tag', target.tag)

    engineFilter(regData)
    if (regData['dist-tags'] && regData['dist-tags'][target.tag] &&
        regData.versions[regData['dist-tags'][target.tag]]) {
      var ver = regData['dist-tags'][target.tag]
      target.spec = ver
      return fetchNamed(target, regData.versions[ver], cb)
    }
    if (!explicit && Object.keys(regData.versions).length) {
      target.spec = '*'
      return fetchNamed(target, regData, cb)
    }

    er = downloadTargetsError(target.tag, regData)
    return cb(er)
  }
}

function engineFilter (data) {
  var npmv = npm.version
  var nodev = npm.config.get('node-version')
  var strict = npm.config.get('engine-strict')

  if (!nodev || npm.config.get('force')) return data

  Object.keys(data.versions || {}).forEach(function (v) {
    var eng = data.versions[v].engines
    if (!eng) return
    if (!strict) return
    if (eng.node && !semver.satisfies(nodev, eng.node, true) ||
        eng.npm && !semver.satisfies(npmv, eng.npm, true)) {
      delete data.versions[v]
    }
  })
}

function fetchNameVersion (target, data, cb) {
  var name = target.name
  var ver = semver.valid(target.spec, true)
  if (!ver) return cb(new Error('Invalid version: ' + target.spec))

  var response

  if (data) {
    response = null
    return next()
  }

  getOnceFromRegistry(name, 'fetchNameVersion', setData, cb)

  function setData (er, d, json, resp) {
    if (!er) {
      er = errorResponse(name, resp)
    }
    if (er) return cb(er)
    data = d && d.versions[ver]
    if (!data) {
      er = new Error('version not found: ' + name + '@' + ver)
      er.package = name
      er.statusCode = 404
      return cb(er)
    }
    response = resp
    next()
  }

  function next () {
    deprCheck(data)
    var dist = data.dist

    if (!dist) return cb(new Error('No dist in ' + packageId(data) + ' package'))

    if (!dist.tarball) {
      return cb(new Error('No dist.tarball in ' + packageId(data) + ' package'))
    }

    mapToRegistry(name, npm.config, function (er, _, auth, ruri) {
      if (er) return cb(er)

      // Use the same protocol as the registry.  https registry --> https
      // tarballs, but only if they're the same hostname, or else detached
      // tarballs may not work.
      var tb = url.parse(dist.tarball)
      var rp = url.parse(ruri)
      if (tb.hostname === rp.hostname && tb.protocol !== rp.protocol) {
        tb.protocol = rp.protocol
        // If a different port is associated with the other protocol
        // we need to update that as well
        if (rp.port !== tb.port) {
          tb.port = rp.port
          delete tb.host
        }
        delete tb.href
      }
      var tbUrl = url.format(tb)

      // Only add non-shasum'ed packages if --forced. Only ancient things
      // would lack this for good reasons nowadays.
      if (!dist.shasum && !npm.config.get('force')) {
        return cb(new Error('package lacks shasum: ' + packageId(data)))
      }

      var inParams = {
        name: name,
        ver: ver,
        url: tbUrl,
        auth: auth,
        shasum: dist.shasum || null
      }
      if (target.tag && target.tag !== 'latest') inParams.tag = target.tag

      fetchRemoteTarball(inParams, cb)
    })
  } // END function next

}

function fetchNameRange (target, data, cb) {
  var name = target.name
  var range = semver.validRange(target.spec, true)
  if (range === null) {
    return cb(new Error(
      'Invalid version range: ' + range
    ))
  }

  log.silly('fetchNameRange', { name: name, range: range, hasData: !!data})

  if (data) return next()

  getOnceFromRegistry(name, 'fetchNameRange', setData, cb)

  function setData (er, d, json, resp) {
    if (!er) {
      er = errorResponse(name, resp)
    }
    if (er) return cb(er)
    data = d
    next()
  }

  function next () {
    log.silly(
      'fetchNameRange',
      'number 2', { name: name, range: range, hasData: !!data }
    )
    engineFilter(data)

    log.silly('fetchNameRange', 'versions',
               [data.name, Object.keys(data.versions || {})])

    var tag = npm.config.get('tag')
    var versions = Object.keys(data.versions || {})
      .filter(function (v) { return semver.valid(v) })
    var picked = pickManifestFromRegistryMetadata(range, tag, versions, data)
    if (picked) {
      target.spec = picked.resolvedTo
      return fetchNamed(target, picked.manifest, cb)
    }

    return cb(downloadTargetsError(range, data))
  }
}

function downloadTargetsError (requested, data) {
  var targets = Object.keys(data['dist-tags']).filter(function (f) {
    return (data.versions || {}).hasOwnProperty(f)
  }).concat(Object.keys(data.versions || {}))

  requested = data.name + (requested ? "@'" + requested + "'" : '')

  targets = targets.length
          ? 'Valid install targets:\n' + targets.join(', ') + '\n'
          : 'No valid targets found.\n'
          + 'Perhaps not compatible with your version of node?'

  var er = new Error( 'No compatible version found: ' + requested + '\n' + targets)
  er.code = 'ETARGET'
  return er
}

function errorResponse (name, response) {
  var er
  if (response.statusCode >= 400) {
    er = new Error(http.STATUS_CODES[response.statusCode])
    er.statusCode = response.statusCode
    er.code = 'E' + er.statusCode
    er.pkgid = name
  }
  return er
}
