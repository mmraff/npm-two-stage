// The offline complement to fetch-remote-git
// Based on an extract from cache/add-remote-git.js

var crypto = require('crypto')
var fs = require('graceful-fs')
var path = require('path')
var url = require('url')

var chownr = require('chownr')
var hostedFromURL = require('hosted-git-info').fromUrl
var inflight = require('inflight')
var log = require('npmlog')
var mkdir = require('mkdirp')
var realizePackageSpecifier = require('realize-package-specifier')
var fstr = require('fstream')
var rm_rf = require('rimraf')

var git = require('./utils/git.js')
var gitAux = require('./download/git-aux.js')
var npm = require('./npm.js')
var addLocal = require('./cache/add-local.js')

module.exports = add
function add (gitData, next, done) {
  // gitData contains fields {from, cloneURL, repoID, treeish, resolvedTreeish}.
  // 'next' is a function factory that takes a callback, perhaps 'done', and
  // returns function(er, cb) that eventually leads to a call of that callback.
  // 'done' is intended to be the penultimate callback.
  //
  done = inflight(gitData.repoID, done)
  if (!done) {
    return log.verbose('gitOffline', gitData.repoID, 'already in flight; waiting')
  }
  log.verbose('tryClone', gitData.repoID, 'not in flight; caching')

  gitAux.getGitDir(npm.cache, function (er, cs) {
    if (er) {
      log.error('gitOffline', gitData.from, 'could not get cache stat')
      return done(er)
    }

    var cachedRemote = path.join(npm.cache, gitAux.remotesDirName(), gitData.repoID)
    fs.stat(cachedRemote, function (fsErr, s) {
      if (fsErr || !s.isDirectory())
        return copyRemote(gitData, cachedRemote, cs, next, done)

      validateExistingRemote(gitData, cachedRemote, cs, next, done)
    })
  })
}

function copyRemote (gitData, cachedRemote, cStats, next, done) {
  log.info('copyRemote', 'copying to', cachedRemote, 'for', gitData.from)

  rm_rf(cachedRemote, { disableGlob: true }, function (rmErr) {
    if (rmErr) return done(rmErr) // No error if cachedRemote does not exist

    var remotesDirName = gitAux.remotesDirName()
    // Source:
    var clonedRemote = path.join(npm.dlTracker.path, remotesDirName, gitData.repoID)
    fstr.Reader(clonedRemote)
      .on('error', function(readErr) {
        log.error('copyRemote', 'fstream.Reader(' + clonedRemote + ')')
        done(readErr)
      })
      .pipe(fstr.Writer({ path: cachedRemote, type: 'Directory' })
        .on('error', function(copyErr) { // Writer error
          log.error('copyRemote', 'fstream.Writer(' + cachedRemote + ')')
          done(copyErr)
        })
        .on('close', function() { // Writer close
          log.verbose('copyRemote', 'cached', gitData.repoID)
          setPermissions(gitData, cachedRemote, cStats, next, done)
        })
      )
  })
}

// reuse a cached remote when possible, but nuke it if it's in an
// inconsistent state
function validateExistingRemote (gitData, cachedRemote, cStats, next, done) {
  git.whichAndExec(
    ['config', '--get', 'remote.origin.url'],
    { cwd: cachedRemote, env: gitAux.gitEnv() },
    function (er, stdout, stderr) {
      var originURL
      if (stdout) {
        originURL = stdout.trim()
        log.silly('validateExistingRemote', gitData.from, 'remote.origin.url:', originURL)
      }

      if (stderr) stderr = stderr.trim()
      if (stderr || er) {
        log.warn('gitOffline', gitData.from, 'overwriting cached repo',
          cachedRemote, 'because of error:', stderr || er)
        return copyRemote(gitData, cachedRemote, next, done)
      }
      else if (gitData.cloneURL !== originURL) {
        log.warn('gitOffline', gitData.from, 'overwriting cached repo',
          cachedRemote, 'because it points to', originURL,
          'and not', gitData.cloneURL
        )
        return copyRemote(gitData, cachedRemote, cStats, next, done)
      }
      cloneCachedRemote(gitData, cachedRemote, next, done)
    }
  )
}

function setPermissions (gitData, cachedRemote, cs, next, done) {
  if (process.platform === 'win32') {
    log.verbose('setPermissions', gitData.from, 'skipping chownr on Windows')
    resolveHead(gitData, cachedRemote, next, done)
  }
  else {
    chownr(cachedRemote, cs.uid, cs.gid, function (er) {
      if (er) {
        log.error(
          'setPermissions',
          'Failed to change git repository ownership under npm cache for',
          cachedRemote
        )
        return done(er)
      }

      log.verbose('setPermissions', gitData.from, 'set permissions on', cachedRemote)

      // always set permissions on the cached remote
      addModeRecursive(cachedRemote, npm.modes.file, function (er) {
        if (er) return done(er)

        cloneCachedRemote(gitData, cachedRemote, next, done)
      })
    })
  }
}

// make a clone from the mirrored cache so we have a temporary directory in
// which we can check out the resolved treeish
function cloneCachedRemote (gitData, cachedRemote, next, done) {
  var thisFunc = 'cloneCachedRemote'
  var resolvedURL = getResolved(gitData.cloneURL, gitData.resolvedTreeish)
  if (!resolvedURL) {
    return done(new Error(
      'unable to clone ' + gitData.from + ' because git clone string ' +
        gitData.cloneURL + ' is in a form npm can\'t handle'
    ))
  }
  log.verbose(thisFunc, gitData.from, 'resolved Git URL:', resolvedURL)

  // generate a unique filename
  var tmpdir = path.join(
    npm.tmp,
    'git-cache-' + crypto.pseudoRandomBytes(6).toString('hex'),
    gitData.resolvedTreeish
  )
  log.silly(thisFunc, 'Creating git working directory:', tmpdir)

  mkdir(tmpdir, function (er) {
    if (er) return done(er)

  // TODO: determine if it's alright to include '--no-checkout', given that we
  // follow this op with a checkout (checkoutTreeish)
    var args = ['clone', cachedRemote, tmpdir]
    git.whichAndExec(
      args,
      { cwd: cachedRemote, env: gitAux.gitEnv() },
      function (er, stdout, stderr) {
        stdout = (stdout + '\n' + stderr).trim()
        if (er) {
          log.error('git ' + args.join(' ') + ':', stderr)
          return done(er)
        }
        log.verbose(thisFunc, gitData.from, 'clone', stdout)

        checkoutTreeish(gitData, resolvedURL, tmpdir, next, done)
      }
    )
  })
}

// there is no safe way to do a one-step clone to a treeish that isn't
// guaranteed to be a branch, so explicitly check out the treeish once it's
// cloned
function checkoutTreeish (gitData, resolvedURL, tmpdir, next, done) {
  var args = ['checkout', gitData.resolvedTreeish]
  git.whichAndExec(
    args,
    { cwd: tmpdir, env: gitAux.gitEnv() },
    function (er, stdout, stderr) {
      stdout = (stdout + '\n' + stderr).trim()
      if (er) {
        log.error('git ' + args.join(' ') + ':', stderr)
        return done(er)
      }
      log.verbose('checkoutTreeish', gitData.from, 'checkout', stdout)

      // convince addLocal that the checkout is a local dependency
      realizePackageSpecifier(tmpdir, function (er, specData) {
        if (er) {
          log.error('fetchRemoteGit', 'Failed to map', tmpdir, 'to a package specifier')
          return done(er)
        }

        next(moreAfterAdd)(null, specData)
      })
    }
  )
  // ensure pack logic is applied
  // https://github.com/npm/npm/issues/6400
  // Get this to happen *after* offliner hands off to its callback
  function moreAfterAdd (er, data) {
    if (data) {
      if (npm.config.get('save-exact')) {
        log.verbose('fetchRemoteGit', 'data._from:', resolvedURL, '(save-exact)')
        data._from = resolvedURL
      } else {
        log.verbose('fetchRemoteGit', 'data._from:', gitData.from)
        data._from = gitData.from
      }

      log.verbose('fetchRemoteGit', 'data._resolved:', resolvedURL)
      data._resolved = resolvedURL
    }
    // NOTE: the source for above (add-remote-git.js) has this function as the
    // callback for addLocal(), so it's adding properties _from and _resolved
    // to whatever data addLocal is sending back.

    done(er, data)
  }

}
// NOTES:
// * realizePackageSpecifier immediately calls npa() on its arg, and sends back
//   an error if npa finds that the arg is not a string.
// * Else npa returns an object, result of parsing the arg
// * realizePackageSpecifier modifies the object and sends it through the callback;
//   therefore 'spec' here is an object, not a string.
// * addLocal() 1st arg *must* be an object, but only required field is 'spec'
// * addLocal() 2nd arg is an optional object 'pkgData';
//   addLocal() passes this as 2nd arg to addLocalTarball or addLocalDirectory.
// * addLocalDirectory only verifies other data against pkgData.
// * add-local ultimately calls addLocalTarball, no matter if type is 'local'
//   or 'directory'; it does *not* pass pkgData, but the result of readJson().
// * In add-local-tarball, ultimately pkgData must be the entire contents of
//   package.json, because that's what gets done with it.

function getResolved (uri, fullTreeish) {
  // normalize hosted-git-info clone URLs back into regular URLs
  // this will only work on URLs that hosted-git-info recognizes
  // https://github.com/npm/npm/issues/7961
  var rehydrated = hostedFromURL(uri)
  if (rehydrated) uri = rehydrated.toString()

  var parsed = url.parse(uri)

  // Checks for known protocols:
  // http:, https:, ssh:, and git:, with optional git+ prefix.
  if (!parsed.protocol ||
      !parsed.protocol.match(/^(((git\+)?(https?|ssh))|git|file):$/)) {
    uri = 'git+ssh://' + uri
  }

  if (!/^git[+:]/.test(uri)) {
    uri = 'git+' + uri
  }

  // Not all URIs are actually URIs, so use regex for the treeish.
  return uri.replace(/(?:#.*)?$/, '#' + fullTreeish)
}

// similar to chmodr except it adds permissions rather than overwriting them
// adapted from https://github.com/isaacs/chmodr/blob/master/chmodr.js
function addModeRecursive (cachedRemote, mode, cb) {
  fs.readdir(cachedRemote, function (er, children) {
    // Any error other than ENOTDIR means it's not readable, or doesn't exist.
    // Give up.
    if (er && er.code !== 'ENOTDIR') return cb(er)
    if (er || !children.length) return addMode(cachedRemote, mode, cb)

    var len = children.length
    var errState = null
    children.forEach(function (child) {
      addModeRecursive(path.resolve(cachedRemote, child), mode, then)
    })

    function then (er) {
      if (errState) return undefined
      if (er) return cb(errState = er)
      if (--len === 0) return addMode(cachedRemote, dirMode(mode), cb)
    }
  })
}

function addMode (cachedRemote, mode, cb) {
  fs.stat(cachedRemote, function (er, stats) {
    if (er) return cb(er)
    mode = stats.mode | mode
    fs.chmod(cachedRemote, mode, cb)
  })
}

// taken from https://github.com/isaacs/chmodr/blob/master/chmodr.js
function dirMode (mode) {
  if (mode & parseInt('0400', 8)) mode |= parseInt('0100', 8)
  if (mode & parseInt('040', 8)) mode |= parseInt('010', 8)
  if (mode & parseInt('04', 8)) mode |= parseInt('01', 8)
  return mode
}
