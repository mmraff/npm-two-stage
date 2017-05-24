module.exports = download

var npm = require("./npm.js")
  , fs = require("graceful-fs")
  , assert = require("assert")
  , log = require("npmlog")
  , path = require("path")
  , asyncMap = require("slide").asyncMap
  , VanillaRegClient = require("./download/vanilla-reg-client.js")
  , DlTracker = require("./download/dltracker.js")
  , fetchNamed = require("./download/fetch-named.js")
  , fetchRemoteTarball = require("./download/fetch-remote-tarball.js")
  , fetchRemoteGit = require("./download/fetch-remote-git.js")
  , gitAux = require("./download/git-aux.js")
  , inflight = require("inflight")
  , npa = require("npm-package-arg")
  , mapToRegistry = require("./utils/map-to-registry.js")
  , normalize = require("normalize-package-data")

  , resolveDeps = require("./download/resolve-dependencies.js")

download.usage = "npm download <tarball url>"
               + "\nnpm download <git url>"
               + "\nnpm download <name>@<version>"

function download (args, cb) {
  assert(args && args.length && typeof args[0] === "string",
         "must identify package to download")
  assert(typeof cb === "function", "must include callback")

  // elements of args can be any of:
  // "pkg@version"
  // "username/projectspec" (github shortcut)
  // "url"
  // This is tricky, because urls can contain @

  var usage = "Usage:\n"
            + "    npm download [--dl-dir=<path>] [<pkg>@<ver>|<tarball-url>] ...\n"

  log.silly("download", "args:", args)

  //if (!spec) return cb(usage)

  var dlDir = npm.config.get('dl-dir')
    , phantom = npm.config.get('dl-phantom')
    , cachingRegClient = npm.registry

  log.verbose("download", "Substituting a no-cache registry client...")
  npm.registry = new VanillaRegClient(npm.config)

  if (dlDir) {
    log.info("download", "configured to use path: " + dlDir)
  } else {
    log.warn("download",
      "No path configured for downloads - current directory will be used."
    )
  }
  npm.dlTracker = new DlTracker()
  npm.dlTracker.initialize(dlDir, phantom, function (errInit) {
    if (errInit) return cb(errInit)

    log.info("download", "established download path:", npm.dlTracker.path)

// TODO: Answer this - do we want the first error to abort the session, or do we
// want to continue trying to fetch anything remaining to fetch?
    asyncMap(Object.keys(args),
      function(i, mapCb) {
        download_(args[i], null, function (dlErr, data) {
          mapCb(null, dlErr ? dlErr : data)
        })
      }, 
      function (_, mapData) {
        // TODO: the error sources may need to be modified to include more information
        // like package name/spec
        var errs
        var errCount = 0
        var errPkgs = []
        for (var i in mapData) {
          if (mapData[i] instanceof Error) {
            errPkgs.push(args[i])
            if (npm.dlTracker.errors && npm.dlTracker.errors[args[i]])
              errs = npm.dlTracker.errors[args[i]]
            else errs = []
            errCount += (errs.length || 1)
            log.error('download', mapData[i].message)
            for (var j in errs) log.error("download", errs[j].message)
          }
          else console.log("Successfully downloaded all packages needed for", args[i])
        }

        if (errPkgs.length) {
          log.error('download', 'Failed to download everything for these specs:')
          log.error(errPkgs)
        }

        // Reset the previously configured registry, in case the return from this
        // will be followed by something that needs it. Not likely, but possible.
        npm.registry = cachingRegClient

        npm.dlTracker.serialize(function (serErr) {
          cb(serErr)
        })
    })
  })
}

var fetching = 0

function download_ (spec, wrap, cb) {
  var target = {}
    , p

  try {
    p = npa(spec)
    if (!p.name) {
      log.warn("download", "No package name parsed from spec", spec)
    }
  }
  catch (err) {
    return cb(err)
  }
  log.silly("download", "parsed spec", p)

  if (fetching <= 0) {
    npm.spinner.start()
  }
  fetching++

  target.name = p.name
  target.spec = p.rawSpec
  if (wrap) target.wrap = wrap
  cb = afterDl(cb, target)

  switch (p.type) {
    case "local":
      return cb(new Error("Cannot download a local module"))

    case "remote":
      target.type = 'url'
      if (npm.dlTracker.contains('url', p.name, p.rawSpec))
        return cb(null, { name: p.name, spec: p.rawSpec, _duplicate: true })

      // get auth, if possible
      mapToRegistry(p.raw, npm.config, function (err, uri, auth) {
        if (err) return cb(err)

        fetchRemoteTarball({
          name: p.name,
          url: p.spec, // because this is what cache.js uses
          auth: auth
        }, cb)
      })
      break
    case "git":
    case "hosted":
      target.type = 'git'
      if (npm.dlTracker.contains('git', p.name, p.rawSpec))
        return cb(null, { name: p.name, spec: p.rawSpec, _duplicate: true })

      fetchRemoteGit(p.rawSpec, cb)
      break
    default:
      if (p.name)
        // It's tempting to send the 'target' object as 1st arg here, but
        // we must not, because the spec field is likely to get changed in its
        // travels through fetch-named.js, and that could cause confusion
        // in afterDl().
        return fetchNamed({ name: p.name, spec: p.spec }, null, cb)

      cb(new Error("couldn't figure out how to download " + spec))
  }
}

// In args below:
// target.name will not exist if root package specified by, e.g., URL on cmdline;
// target.spec is always npa.parse(origSpec).rawSpec;
// target.type is 'url' if npa.parse(origSpec).type==="remote",
//                'git' if npa.parse(origSpec).type==="git" or "hosted";
// target.wrap set to inherited shrinkwrap data, if any.
// dlResult fields potentially set in fetch-remote-tarball:
//   name, version, tag, filename, anomaly, _from, _resolved, _shasum
// dlResult fields set in fetch-remote-git:
//   from, cloneURL, treeish, repoID, resolvedTreeish
// dlResult fields potentially set in download_ (above) or in fetch-named:
//   name, version, _duplicate, _from (= name + "@" + spec)
// (NOTE that the _from value will *overwrite* what got set on that by fetch-remote-tarball)
// 
function afterDl (cb, target) { return function (er, dlResult, pkgData, wrapData) {
  fetching--
  if (fetching <= 0) npm.spinner.stop()

  if (er) return cb(er, dlResult)

  // REGARDING dlResult._duplicate:
  // Two things we know: returning here (a) avoids redundant adding to the
  // dlTracker, and (b) avoids recursing again into the dependencies (which
  // we assume we already have, if we already have this package)
  //
  // TODO: Potential problem, to be traced and verified: What if we already got
  // the target by a semver version spec, but this time it was specified by a
  // tag, other than 'latest'? Or even a URL? We would need to get that other
  // spec into the appropriate map through the tracker, even if not downloaded...
  if (dlResult._duplicate) return cb(null, dlResult)

  // TODO: This might be a case worth more attention: no error, but no package.json,
  // so "nothing is wrong, but something's not right"
  if (!pkgData) return cb(null, dlResult)

  log.silly("download", "afterDl result:", dlResult)

  var fname = target.type === 'git' ?
      path.join(gitAux.remotesDirName(), dlResult.repoID) : dlResult.filename
  var fpath = path.resolve(npm.dlTracker.path, fname)
  var done = inflight(fpath, cb)
  if (!done) return log.verbose("afterDl", fpath, "already in flight; not adding")

  log.verbose("afterDl", fpath, "not in flight; adding")

  if (!dlResult.name) dlResult.name = target.name || pkgData.name
  if (!dlResult.spec) dlResult.spec = target.spec
  if (dlResult.tag && dlResult.tag !== 'latest') {
    target.type = 'tag'
    dlResult.spec = dlResult.tag
  }
  npm.dlTracker.add(target.type || 'semver', dlResult, function (addErr) {
    if (addErr) return done(addErr)
    fetchDependencies(target, pkgData, wrapData, done)
  })
}}

function fetchDependencies(target, pkgData, wrapData, cb)
{
  var opts = { dev: npm.config.get("dev") }
  if (npm.config.get("optional")) opts.optional = true

  var useShrinkwrap = npm.config.get("shrinkwrap")
  if (typeof useShrinkwrap == "boolean") opts.useShrinkwrap = useShrinkwrap
  if (target.wrap) opts.wrap = target.wrap
  else if (useShrinkwrap && wrapData) opts.newwrap = wrapData

  resolveDeps(pkgData, opts, function (er, resolved, wrap) {
    if (er) { return cb(er) }

    // TODO: add some code to make use of resolved.optionalDependencies!
    // resolveDeps does not add them to dependencies, but we can observe
    // opts.optional here...
    var deps = resolved.dependencies || {}
      , depErrors = null

    asyncMap(Object.keys(deps),
      function (k, mapCb) {
        // Recurse!
        // the only use of wrap
        download_(k + '@' + deps[k], wrap, function (er, depData) {
          if (er) {
            if (!depErrors) { depErrors = [] }
            depErrors.push(er.message + ' (' + k + '@' + deps[k] + ')')
            // TODO:
            // Check all the cb() chain before this: is the error already logged in all cases?
            // If so, don't need to do this here:
            log.error("download", er.message)

            return mapCb(er)
          }
          if (!depData._duplicate) {
            log.verbose("download", "Complete: %s@%s, dependency of %s@%s",
              depData.name, depData.version, target.name, target.spec
            )
          } else {
            log.silly("download", "We already had %s@%s",
                      depData.name, depData.version)
          }
          mapCb(null, depData)
        })
      },
      function(er, mapData) { // finally...
        if (er) {
          var id = target.name + '@' + target.spec
          if (!npm.dlTracker.errors) npm.dlTracker.errors == {}
          npm.dlTracker.errors[id] = depErrors
          er = new Error("Failure(s) while fetching dependencies of " + id)
        }
        cb(er, target)
      }
    ) // end asyncMap call
  }) // end callback for resolveDeps
} // end function fetchDependencies

