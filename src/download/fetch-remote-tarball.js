var assert = require('assert')
var log = require('npmlog')
var path = require('path')
var sha = require('sha')
var retry = require('retry')
var writeStreamAtomic = require('fs-write-stream-atomic')
var PassThrough = require('readable-stream').PassThrough
var normalizePkgData = require('normalize-package-data')
var npm = require('../npm.js')
var inflight = require('inflight')
var getDlFilename = require('./get-dl-filename.js')
var filenameParser = require('./npm-package-filename.js')
var readTarballJson = require('../fetch-package-metadata.js').readTarballJson
var semver = require('semver')
var pulseTillDone = require('../utils/pulse-till-done.js')

module.exports = fetchRemoteTarball

// This is called from download_ (in download.js) and fetchNamed (fetch-named.js).
// Result data fields potentially set here: name, version, tag, filename, anomaly,
// and the three underscore-prefixed ones below.
function fetchRemoteTarball (inParams, _cb) {

  assert(typeof inParams === 'object' && typeof inParams.url === 'string',
         'must have module URL')
  assert(typeof _cb === 'function', 'must have callback')

  if (!inParams.name)
    log.warn('fetchRemoteTarball', 'Package name not known in advance')
  if (!inParams.ver)
    log.warn('fetchRemoteTarball', 'Package version not known in advance')

  var u = inParams.url
  var shasum = inParams.shasum

  _cb = inflight(u, _cb)
  if (!_cb) return log.verbose('fetchRemoteTarball', u, 'already in flight; waiting')
  log.verbose('fetchRemoteTarball', u, 'not in flight; adding')
  log.verbose('fetchRemoteTarball', [u, shasum])

  function cb (er, dlData) {
    if (dlData) {
      dlData._from = u
      dlData._resolved = u
      dlData._shasum = dlData._shasum || shasum

      getPackageData(dlData.filename, function(pdErr, pkgData, wrapData) {
        _cb(pdErr, dlData, pkgData, wrapData)
      })
    }
    else _cb(er)
  }

  // Tuned to spread 3 attempts over about a minute.
  // See formula at <https://github.com/tim-kos/node-retry>.
  var operation = retry.operation({
    retries: npm.config.get('fetch-retries'),
    factor: npm.config.get('fetch-retry-factor'),
    minTimeout: npm.config.get('fetch-retry-mintimeout'),
    maxTimeout: npm.config.get('fetch-retry-maxtimeout')
  })
  operation.attempt(function (currentAttempt) {
    log.info(
      'retry',
      'fetch attempt', currentAttempt,
      'at', (new Date()).toLocaleTimeString()
    )
    fetchAndShaCheck(inParams, function (er, response, dlData) {
      // Only retry on 408, 5xx or no `response`.
      var sc = response && response.statusCode
      var statusRetry = !sc || (sc === 408 || sc >= 500)
      if (er && statusRetry && operation.retry(er)) {
        log.warn('retry', 'will retry, error on last attempt: ' + er)
        return
      }
      cb(er, dlData)
    })
  })
}

function fetchAndShaCheck (inParams, cb) {
  cb = pulseTillDone('fetchTarball', cb)
  npm.registry.fetch(inParams.url, { auth : inParams.auth },
    function afterFetch (er, response) {
      var thisFunc = 'afterFetch'
      if (er) {
        log.error(thisFunc, 'fetch failed', inParams.url)
        return cb(er, response)
      }

      // Options to get a name for the download, in order of preference:
      // 1. If both name & version are available, construct from those.
      //    If dlData.version is set non-null below, we know it's valid!
      // 2. Try to get the filename from the response headers.
      // 3. See if basename from the URL is acceptable as a package filename.
      // 4. If a semver-compliant version string is recognized in the basename
      //    of the URL, concatenate the version tail onto the package name.
      // 5. If none of these works, just ensure that the basename of the URL
      //    has the package name prefixed onto it, and that there's no file by
      //    that name already in the dl-dir.

      var dlData = {}
      var version = inParams.ver && semver.valid(inParams.ver, true)
      if (version) dlData.version = version
      if (inParams.name) dlData.name = inParams.name
      if (inParams.tag && inParams.tag !== 'latest') dlData.tag = inParams.tag

      // Option #1
      if (dlData.name && dlData.version) {
        dlData.filename = dlData.name + '-' + dlData.version + '.tar.gz'
      }
      if (!dlData.filename) {
        // Option #2
        deriveFromResponse(response, dlData)
      }
      if (!dlData.filename) {
        // Options #3-5
        deriveFromURL(inParams.url, dlData)
      }

      var filePath = path.join(npm.dlTracker.path, dlData.filename)
      var tarball = writeStreamAtomic(filePath, { mode : npm.modes.file })
      tarball.on('error', function (er) {
        cb(er)
        tarball.destroy()
      })

      tarball.on('finish', function () {
        if (!inParams.shasum) {
          // Well, we weren't given a shasum, so at least sha what we have
          // in case we want to compare it to something else later
          return sha.get(filePath, function (er, shasum) {
            log.silly('fetchAndShaCheck', 'calculated shasum', shasum)
            dlData._shasum = shasum
            cb(er, response, dlData)
          })
        }

        // validate that the url we just downloaded matches the expected shasum.
        log.silly('fetchAndShaCheck', 'expected shasum', inParams.shasum)
        sha.check(filePath, inParams.shasum, function (er) {
          if (er && er.message) {
            // add original filename for better debuggability
            er.message = er.message + '\n' + 'From:     ' + inParams.url
          }
          else { dlData._shasum = inParams.shasum }
          cb(er, response, dlData)
        })
      })

      // See note about 0.8 http streams bug in cache/add-remote-tarball.js
      response.pipe(PassThrough({highWaterMark: Infinity})).pipe(tarball)
  })
}

// deriveFromResponse: try to extract from the given response headers object
// whatever information missing from dlData that we need to create a filename
// for a package tarball.
//
// TODO: seriously consider getting rid of the 'anomaly' property, since I have
// no plans for what to do with it, and currently it's not enough information
//
function deriveFromResponse(response, dlData)
{
  var thisFunc = 'deriveFromResponse'
  var filename = getDlFilename(response)
  var parsed

  if (!filename)
    return log.verbose(thisFunc, 'No filename from response headers')

  dlData.filename = filename
  parsed = filenameParser.parse(filename)
  if (!parsed) {
    log.verbose(thisFunc,
      'Non-conforming filename from response header:', filename)
    if (!dlData.name) {
      if (!dlData.version) dlData.anomaly = 'all'
      else dlData.anomaly = 'name,filename'
    }
    else dlData.anomaly = 'version,filename'
  }
  else {
    if (!dlData.name) { dlData.name = parsed.packageName }
    else if (parsed.packageName !== dlData.name) {
      log.warn(thisFunc, 
        "Module name '%s' from response does not match expected name '%s'",
        parsed.packageName, dlData.name
      )
      dlData.anomaly = 'name'
    }
    if (!dlData.version) dlData.version = parsed.versionComparable
    else if (parsed.versionComparable !== dlData.version) {
      log.warn(thisFunc, 
        "Module version '%s' from response does not match expected version '%s'",
        parsed.versionComparable, dlData.version
      )
      dlData.anomaly = 'version'
    }
  }
}

// deriveFromURL: try to extract from the given URL whatever information
// missing from dlData that we need to create a filename for a tarball.
//
// NOTE: semver.valid(expr, true) is used before the call to this,
// so we are sure that dlData.version can only be a (loose) valid
// version or null. (It will be null when expr is a URL, for example.)
// If version is not null, then name is empty; else the 1st preference for
// deriving a filename would have been satisfied, and this would not be called.
//
// Also, u is a valid URL, else the callback to npm.registry.fetch() would
// have ditched with an error before the call to this.
//
// NOTE: I *think* we can depend on the URL convention {domain}/{user}/{project}/
// when the domain is github.com, but probably not otherwise; therefore such
// parsing of the URL for a missing package name is not attempted here.
//
function deriveFromURL(u, dlData)
{
  var thisFunc = 'deriveFromURL'
  var urlParsed = url.parse(u)
  var urlBasename = path.basename(urlParsed.pathname)
  var fnameParsed = filenameParser.parse(urlBasename)

  if (fnameParsed) {
    log.verbose(thisFunc, 'URL basename %s is acceptable', urlBasename)
    dlData.filename = urlBasename
    delete dlData.anomaly
    if (!dlData.name) dlData.name = fnameParsed.packageName
    else if (fnameParsed.packageName !== dlData.name) {
      log.warn(thisFunc, 
        "Module name '%s' from URL does not match expected name '%s'",
        fnameParsed.packageName, dlData.name
      )
      dlData.anomaly = 'name'
    }
    if (!dlData.version) dlData.version = fnameParsed.versionComparable
    else if (fnameParsed.versionComparable !== dlData.version) {
      log.warn(thisFunc, 
        "Module version '%s' from URL does not match expected version '%s'",
        fnameParsed.versionComparable, dlData.version
      )
      dlData.anomaly = 'version'
    }
  }
  else {
    var ver = filenameParser.extractVersion(urlBasename) ||
              filenameParser.extractVersion(urlParsed.pathname)
    if (ver) {
      dlData.version = ver
      if (dlData.name) {
        log.verbose(thisFunc, "filename can be built from '%s' and '%s'",
          dlData.name, urlParsed.pathname)
        dlData.filename = dlData.name + '-' + ver + '.tar.gz'
        delete dlData.anomaly
      }
      else {
        // It's possible for a spec given on the command line to be nothing but
        // a URL, among other no-name edge cases; but that seems to be the only
        // way to get here without a package name.
        log.verbose(thisFunc, "Could not derive conforming filename from '%s'",
          urlParsed.pathname)
        dlData.filename = urlBasename
        dlData.anomaly = 'name,filename'
      }
    }
    else {
      if (dlData.name) {
        if (urlBasename.indexOf(dlData.name) === -1) {
          dlData.filename = dlData.name + '-' + urlBasename
        }
        dlData.anomaly = 'version,filename'
      }
      else {
        dlData.filename = urlBasename
        dlData.anomaly = 'all'
      }
    }

    if (!filenameParser.hasTarballExtension(dlData.filename)) {
      dlData.filename += '.tar.gz'
    }
  }
}

function getPackageData (tbName, cb) {
  var filePath = path.join(npm.dlTracker.path, tbName)
  readTarballJson(filePath, 'package.json', function (pjErr, pkgData) {
    log.silly('getPackageData', 'readTarballJson(package.json) callback entry')
    if (pjErr) return cb(pjErr)
    if (pkgData === null) {
      pjErr = new Error('No package.json found in ' + tbName)
      pjErr.code = 'ENOPACKAGEJSON'
      return cb(pjErr)
    }

    try { normalizePkgData(pkgData) }
    catch (normErr) {
      log.error('getPackageData', 'While normalizing package data from', tbName)
      return cb(normErr)
    }

    if (npm.config.get('shrinkwrap') === false) return cb(null, pkgData)

    readTarballJson(filePath, 'npm-shrinkwrap.json', function (err, wrapData) {
      log.silly('getPackageData', 'readTarballJson(npm-shrinkwrap.json) callback entry')
      // No error if no shrinkwrap file found;
      // errors only from untar, jsonParse, ...
      if (err)
        log.error('getPackageData', 'getting npm-shrinkwrap.json from', tbName)
      cb(err, pkgData, wrapData)
    })
  })
}

