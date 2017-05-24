var assert = require('assert')
var crypto = require('crypto')
var fs = require('graceful-fs')
var path = require('path')

var dezalgo = require('dezalgo')
var hostedFromURL = require('hosted-git-info').fromUrl
var inflight = require('inflight')
var log = require('npmlog')
var mkdir = require('mkdirp')
var normalizeGitUrl = require('normalize-git-url')
var npa = require('npm-package-arg')
var normalizePkgData = require('normalize-package-data')
var rm_rf = require('rimraf')

var git = require('../utils/git.js')
var gitAux = require('./git-aux.js')
var npm = require('../npm.js')
var rm = require('../utils/gently-rm.js')

// result data fields set here: from, cloneURL, treeish, repoID, resolvedTreeish.
// These have meaning throughout git-offline.js.

module.exports = fetchRemoteGit

function fetchRemoteGit (uri, cb_) {
  assert(typeof uri === 'string', 'must have git URL')
  assert(typeof cb_ === 'function', 'must have callback')
  var cb = dezalgo(cb_)

  log.verbose('fetchRemoteGit', 'caching', uri)

  // the URL comes in exactly as it was passed on the command line, or as
  // normalized by normalize-package-data / read-package-json / read-installed,
  // so figure out what to do with it using hosted-git-info
  var parsed = hostedFromURL(uri)
  if (parsed) {
    // normalize GitHub syntax to org/repo (for now)
    var from
    if (parsed.type === 'github' && parsed.default === 'shortcut') {
      from = parsed.path()
    } else {
      from = parsed.toString()
    }

    log.verbose('fetchRemoteGit', from, 'is a repository hosted by', parsed.type)

    // prefer explicit URLs to pushing everything through shortcuts
    if (parsed.default !== 'shortcut') {
      return tryClone(from, parsed.toString(), false, cb)
    }

    // try git:, then git+ssh:, then git+https: before failing
    tryGitProto(from, parsed, cb)
  } else {
    // verify that this is a Git URL before continuing
    parsed = npa(uri)
    if (parsed.type !== 'git') {
      return cb(new Error(uri + 'is not a Git or GitHub URL'))
    }

    tryClone(parsed.rawSpec, uri, false, cb)
  }
}

function tryGitProto (from, hostedInfo, cb) {
  var gitURL = hostedInfo.git()
  if (!gitURL) return trySSH(from, hostedInfo, cb)

  log.silly('tryGitProto', 'attempting to clone', gitURL)
  tryClone(from, gitURL, true, function (er) {
    if (er) return tryHTTPS(from, hostedInfo, cb)

    cb.apply(this, arguments)
  })
}

function tryHTTPS (from, hostedInfo, cb) {
  var httpsURL = hostedInfo.https()
  if (!httpsURL) {
    return cb(new Error(from + ' can not be cloned via Git, SSH, or HTTPS'))
  }

  log.silly('tryHTTPS', 'attempting to clone', httpsURL)
  tryClone(from, httpsURL, true, function (er) {
    if (er) return trySSH(from, hostedInfo, cb)

    cb.apply(this, arguments)
  })
}

function trySSH (from, hostedInfo, cb) {
  var sshURL = hostedInfo.ssh()
  if (!sshURL) return tryHTTPS(from, hostedInfo, cb)

  log.silly('trySSH', 'attempting to clone', sshURL)
  tryClone(from, sshURL, false, cb)
}

function tryClone (from, combinedURL, silent, cb) {
  log.silly('tryClone', 'cloning', from, 'via', combinedURL)

  var normalized = normalizeGitUrl(combinedURL)
  var gitData = {
    from: from,
    cloneURL: normalized.url,
    treeish: normalized.branch
  }

  // ensure that similarly-named remotes don't collide
  var repoID = gitData.cloneURL.replace(/[^a-zA-Z0-9]+/g, '-') + '-' +
    crypto.createHash('sha1').update(combinedURL).digest('hex').slice(0, 8)
  gitData.repoID = repoID

  cb = inflight(repoID, cb)
  if (!cb) {
    return log.verbose('tryClone', repoID, 'already in flight; waiting')
  }
  log.verbose('tryClone', repoID, 'not in flight; caching')

  // initialize the remotes clone location;
  // save for later any worry about correct perms
  gitAux.getGitDir(npm.dlTracker.path, function (er) {
    if (er) return cb(er)

    var clonedRemote = path.join(npm.dlTracker.path, gitAux.remotesDirName(), repoID)
    fs.stat(clonedRemote, function (er, s) {
      if (er) return mirrorRemote(gitData, clonedRemote, silent, cb)
      if (!s.isDirectory()) return resetRemote(gitData, clonedRemote, cb)

      validateExistingRemote(gitData, clonedRemote, cb)
    })
  })
}

// don't try too hard to hold on to a remote
function resetRemote (gitData, clonedRemote, cb) {
  log.info('resetRemote', 'resetting', clonedRemote, 'for', gitData.from)
  rm(clonedRemote, function (er) {
    if (er) return cb(er)
    mirrorRemote(gitData, clonedRemote, false, cb)
  })
}

// reuse a cached remote when possible, but nuke it if it's in an
// inconsistent state
function validateExistingRemote (gitData, clonedRemote, cb) {
  git.whichAndExec(
    ['config', '--get', 'remote.origin.url'],
    { cwd: clonedRemote, env: gitAux.gitEnv() },
    function (er, stdout, stderr) {
      var originURL
      if (stdout) {
        originURL = stdout.trim()
        log.silly('validateExistingRemote', gitData.from, 'remote.origin.url:', originURL)
      }

      if (stderr) stderr = stderr.trim()
      if (stderr || er) {
        log.warn('fetchRemoteGit', gitData.from, 'resetting remote', clonedRemote,
          'because of error:', stderr || er)
        return resetRemote(gitData, clonedRemote, cb)
      } else if (gitData.cloneURL !== originURL) {
        log.warn(
          'fetchRemoteGit',
          gitData.from,
          'pre-existing cached repo', clonedRemote, 'points to', originURL,
          'and not', gitData.cloneURL
        )
        return resetRemote(gitData, clonedRemote, cb)
      }

      log.verbose('validateExistingRemote', gitData.from,
        'is updating existing cached remote', clonedRemote)
      updateRemote(gitData, clonedRemote, cb)
    }
  )
}

// make a complete bare mirror of the remote repo
// NOTE: npm uses a blank template directory to prevent weird inconsistencies
// https://github.com/npm/npm/issues/5867
function mirrorRemote (gitData, clonedRemote, silent, cb) {
  mkdir(clonedRemote, function (er) {
    if (er) return cb(er)

    var args = [
      'clone',
      '--template=' + path.join(
        npm.dlTracker.path,
        gitAux.remotesDirName(), 
        gitAux.templateDirName()
      ),
      '--mirror',
      gitData.cloneURL, clonedRemote
    ]
    git.whichAndExec(
      args,
      { cwd: clonedRemote, env: gitAux.gitEnv() },
      function (er, stdout, stderr) {
        if (er) {
          var combined = (stdout + '\n' + stderr).trim()
          var command = 'git ' + args.join(' ') + ':'
          if (silent) {
            log.verbose(command, combined)
          } else {
            log.error(command, combined)
          }
          return cb(er)
        }
        log.verbose('mirrorRemote', gitData.from,
          'git clone ' + gitData.cloneURL, stdout.trim())

        resolveHead(gitData, clonedRemote, cb)
      }
    )
  })
}

// always fetch the origin, even right after mirroring, because this way
// permissions will get set correctly
function updateRemote (gitData, clonedRemote, cb) {
  git.whichAndExec(
    ['fetch', '-a', 'origin'],
    { cwd: clonedRemote, env: gitAux.gitEnv() },
    function (er, stdout, stderr) {
      if (er) {
        var combined = (stdout + '\n' + stderr).trim()
        log.error('git fetch -a origin (' + gitData.cloneURL + ')', combined)
        return cb(er)
      }
      log.verbose('updateRemote', 'git fetch -a origin (' + gitData.cloneURL + ')',
        stdout.trim())

      resolveHead(gitData, clonedRemote, cb)
    }
  )
}

// branches and tags are both symbolic labels that can be attached to different
// commits, so resolve the commit-ish to the current actual treeish the label
// corresponds to
// This needs to be done so that the correct commit can be retrieved by checkout;
// but it only needs to be done once if the result (resolvedTreeish) can be
// retained in the data stored by the DlTracker.
//
// important for shrinkwrap
function resolveHead (gitData, clonedRemote, cb) {
  log.verbose('resolveHead', gitData.from, 'original treeish:', gitData.treeish)
  var args = ['rev-list', '-n1', gitData.treeish]
  git.whichAndExec(
    args,
    { cwd: clonedRemote, env: gitAux.gitEnv() },
    function (er, stdout, stderr) {
      if (er) {
        log.error('git ' + args.join(' ') + ':', stderr)
        return cb(er)
      }

      var resolvedTreeish = stdout.trim()
      log.silly('resolveHead', gitData.from, 'resolved treeish:', resolvedTreeish)
      gitData.resolvedTreeish = resolvedTreeish

      cloneResolved(gitData, clonedRemote, cb)
    }
  )
}

// make a clone from the mirrored cache so we have a temporary directory in
// which we can check out the package.json of the resolved treeish
function cloneResolved (gitData, clonedRemote, cb) {
  // generate a unique filename
  var tmpdir = path.join(
    npm.tmp,
    'git-cache-' + crypto.pseudoRandomBytes(6).toString('hex')
  )
  var tmpCloneDir = path.join(tmpdir, gitData.resolvedTreeish)
  log.silly('cloneResolved', 'Creating git clone temp directory:', tmpCloneDir)

  function done(er, pkgData, wrapData) {
    log.silly('cloneResolved', 'Removing git temp directory:', tmpdir)
    rm_rf(tmpdir, { disableGlob: true }, function (rmErr) {
      if (rmErr) {
        // Messy, but not a big problem
        log.warn('cloneResolved', 'failed to delete git temp dir', tmpdir)
      }
      // At the other end of this is resolution of dependencies & fetching
      cb(er, gitData, pkgData, wrapData)
    })
  }

  mkdir(tmpCloneDir, function (mkdErr) {
    if (mkdErr) return cb(mkdErr)

    var args = ['clone', '--no-checkout', clonedRemote, tmpCloneDir]
    git.whichAndExec(
      args,
      { cwd: clonedRemote, env: gitAux.gitEnv() },
      function (gitErr, stdout, stderr) {
        stdout = (stdout + '\n' + stderr).trim()
        if (gitErr) {
          log.error('git ' + args.join(' ') + ':', stderr)
          return done(gitErr)
        }
        log.verbose('cloneResolved', gitData.from, 'clone', stdout)

        getPackageData(gitData, tmpCloneDir, done)
      }
    )
  })
}

function getPackageData (gitData, tmpdir, done) {

  checkoutTreeishFile(gitData, 'package.json', tmpdir, false, function(er) {
    if (er) {
      if (er.message.indexOf('did not match any file') !== -1) {
        log.warn('getPackageData', gitData.from, 'has no package.json')
        return done()
        // TODO: find out if this must be pursued - for example,
        // the weirdo case of index.js with embedded package data
      }
      return done(er)
    }
    log.silly('getPackageData', 'Checked out temporary copy of package.json for',
      gitData.from)

    readJsonFile(path.join(tmpdir, 'package.json'), function(er, pkgData) {
      if (er) return done(er)

      try { normalizePkgData(pkgData) }
      catch (normErr) {
        log.error('getPackageData', 'While normalizing package data from', gitData.from)
        return done(normErr)
      }
      log.silly('getPackageData', 'Successfully normalized package data for', gitData.from)

      if (npm.config.get("shrinkwrap") === false) return done(null, pkgData)

      getShrinkwrap(gitData, tmpdir, function (er, wrapData) {
        done(er, pkgData, wrapData)
      })
    })
  })
}

function getShrinkwrap (gitData, tmpdir, cb) {
  var filename = 'npm-shrinkwrap.json'
  checkoutTreeishFile(gitData, filename, tmpdir, true, function(shcoErr) {
    if (shcoErr) {
      log.verbose('getShrinkwrap', gitData.from, 'has no', filename)
      return cb()
    }

    readJsonFile(path.join(tmpdir, filename), function(shrErr, wrapData) {
      if (shrErr)
        log.error('getShrinkwrap', 'Failed to read', filename, 'for', gitData.from)
      cb(shrErr, wrapData)
    })
  })
}

function checkoutTreeishFile (gitData, filepath, tmpdir, shutup, cb) {
  var args = ['checkout', gitData.resolvedTreeish, filepath]
  git.whichAndExec(
    args,
    { cwd: tmpdir, env: gitAux.gitEnv() },
    function (er, stdout, stderr) {
      stdout = (stdout + '\n' + stderr).trim()
      if (er) {
        if (!shutup) log.error('git ' + args.join(' ') + ':', stderr)
        return cb(er)
      }

      log.verbose('checkoutTreeishFile', gitData.from, 'checkout', filepath)
      cb()
    }
  )
}

function readJsonFile (jsonpath, cb) {
  log.silly("readJsonFile", jsonpath)
  fs.readFile(jsonpath, 'utf8', function (fsErr, s) {
    if (fsErr) return cb(fsErr)

    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1) // strip BOM, if any
    var data
    try { data = JSON.parse(s) }
    catch (parseErr) {
      log.error('readJsonFile', 'JSON.parse exception,', jsonpath)
      cb(parseErr)
    }
    log.silly('readJsonFile', 'Successfully parsed', jsonpath)
    cb(null, data)
  })
}

