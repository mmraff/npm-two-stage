'use strict'

module.exports = download

const usage = require('./utils/usage')

download.usage = usage(
  'download',
  [
    '',
    '  npm download [<@scope>/]<name>',
    '  npm download [<@scope>/]<name>@<tag>',
    '  npm download [<@scope>/]<name>@<version>',
    '  npm download [<@scope>/]<name>@<version range>',
    '  npm download <git-host>:<git-user>/<repo-name>',
    '  npm download <github username>/<github project>',
    '  npm download <git repo url>',
    '  npm download <tarball url>',
    '',
    'Multiple items can be named as above on the same command line.',
    'Alternatively, dependencies can be drawn from a package.json file:',
    '',
    '  npm download --package-json[=<path-with-a-package.json>]',
    '  npm download --pj[=<path-with-a-package.json>]',
    '  npm download -J',
    '',
    'If <path-with-a-package.json> is not given, the package.json file is',
    'expected to be in the current directory.',
    'The last form assumes this.'
  ].join('\n'),
  [
    '',
    '  --dl-dir=<path>',
    '  --only=dev[elopment]',
    '  --also=dev[elopment]      ***deprecated***',
    '  --include=dev[elopment]',
    '  --no-optional',
    '  --no-shrinkwrap'
  ].join('\n')
)

// built-in packages
const fs = require('fs')
const path = require('path')
const url = require('url')
const util = require('util')

// external dependencies
const BB = require('bluebird')
const finalizeManifest = require('pacote/lib/finalize-manifest')
const log = require('npmlog')
const mkdirpAsync = BB.promisify(require('mkdirp'))
const npa = require('npm-package-arg')
const pacote = require('pacote')
const rimraf = require('rimraf')
const semver = require('semver')
const validate = require('aproba')

// npm internal utils
const DlTracker = require("./download/dltracker.js")
const gitAux = require('./download/git-aux')
const gitContext = require('./download/git-context')
const npf = require('./download/npm-package-filename')
const npm = require('./npm.js')

const cmdOpts = {}
const latest = {}
const inflight = {}

const tempCache = path.join(npm.tmp, 'dl-temp-cache')

function DuplicateSpecError() {}
DuplicateSpecError.prototype = Object.create(Error.prototype)

// There is a case in which a devDependency is *not* marked as such in a
// shrinkwrap file: the package in question is "both a development dependency
// of the top level and a transitive dependency of a non-development dependency
// of the top level."
// This function resolves that. However, it must *not* be used when culling
// devDependencies (rely on 'dev' field in the shrinkwrap dependency record
// for that).
function isDevDep(name, vSpec, manifest) {
  var result
  const devDeps = manifest.devDependencies
  if (!devDeps || !(name in devDeps))
    result = false
  else if (semver.valid(vSpec) && semver.validRange(devDeps[name])) {
    result = semver.satisfies(vSpec, devDeps[name])
  }
  else {
    log.warn('download isDevDep', `non-semver case: ${vSpec} vs. ${devDeps[name]}`)
    result = vSpec.indexOf(devDeps[name]) !== -1
  }
  return result
}

// Tame those nested arrays
function xformResult(res) {
  return res.reduce((acc, val) => acc.concat(val), [])
}

function download (args, cb) {
  validate('AF', [args, cb])

  log.silly('download', 'args:', args)

  cmdOpts.dlDir = npm.config.get('dl-dir')
  cmdOpts.phantom = npm.config.get('dl-phantom') // this is still unimplemented
  cmdOpts.noOptional = npm.config.get('no-optional')
  cmdOpts.noShrinkwrap = npm.config.get('no-shrinkwrap')
  cmdOpts.include = new Set()
  const optInclude = npm.config.get('include')
  if (optInclude) {
    const includeItems = optInclude.split(',')
    for (let i = 0; i < includeItems.length; ++i) {
      if (includeItems[i] == 'development') cmdOpts.include.add('dev')
      else cmdOpts.include.add(includeItems[i])
    }
  }
  const optAlso = npm.config.get('also')
  if (optAlso) { // must be either 'development' or 'dev'
    if (!cmdOpts.include.has('dev'))
      cmdOpts.include.add('dev')
  }
  const optOnly = npm.config.get('only')
  if (optOnly) {
    cmdOpts.onlyProd = /^prod(uction)?$/.test(optOnly)
    cmdOpts.onlyDev = /^dev(elopment)?$/.test(optOnly)
  }
  // NOTE that cmdOpts.include *can* be in conflict with either of the above.
  // According to npmjs doc for `npm install`, --include overrides --omit.
  // Make it also override the implied omit of --only.
  const optPj = npm.config.get('package-json') || npm.config.get('pj') || npm.config.get('J')
  if (optPj) {
    cmdOpts.packageJson = typeof optPj == 'boolean' ? './' : optPj
    cmdOpts.packageJson.replace(/package\.json$/, '')
    if (!cmdOpts.packageJson) cmdOpts.packageJson = './'
  }

  if (!(cmdOpts.packageJson || (args && args.length > 0))) {
    return cb(new SyntaxError([
      'No packages named for download.',
      'Maybe you want to use the package-json option?',
      'Try: npm download -h'
    ].join('\n')))
  }

  /*
  include dev   only dev    only prod
  0             0           0           -> ignore dev
  0             1           0
  0             0           1           -> ignore dev
  1             0           0
  1             1           0
  1             0           1
  */
  cmdOpts.IGNORE_DEV_DEPS = !cmdOpts.include.has('dev') && !cmdOpts.onlyDev

  if (cmdOpts.dlDir) {
    log.info('download', 'requested path:', cmdOpts.dlDir)
  }
  else {
    log.warn('download',
      'No path configured for downloads - current directory will be used.'
    )
  }

  DlTracker.create(cmdOpts.dlDir, { log: log }, function(er, newTracker) {
    if (er) return cb(er)

    log.info('download', 'established download path:', newTracker.path)

     mkdirpAsync(tempCache)
    .then(() => {
      npm.dlTracker = newTracker
      let statsMsgs = ''
      const pjPromise = !cmdOpts.packageJson ? BB.resolve([]) :
        pacote.manifest(cmdOpts.packageJson).then(mani => {
          return processDependencies(mani, { topLevel: true })
          .then(results => {
            const pjResults = xformResult(results)
            statsMsgs = getItemResultsStats('package.json', pjResults)
            return pjResults
          })
        })

      pjPromise.then(pjResults => {
        return args.length ?
          BB.map(args, function (item) {
            return processItem(item, { topLevel: true })
            .then(results => {
              statsMsgs += getItemResultsStats(item, results)
              return results
            })
          })
          .then(results => {
            if (pjResults.length) results = pjResults.concat(results)
            return results
          })
          :
          pjResults
      })
      .then(results => {
        // results is an array of arrays, 1 for each spec on the command line.
        rimraf(tempCache, function(rimrafErr) {
          if (rimrafErr)
            log.warn('download', 'failed to delete the temp dir ' + tempCache)

          newTracker.serialize(function(serializeErr) {
            // The console call follows the callback call here because when
            // placed before, it causes a stutter in the npm log output.
            cb(serializeErr, results)
            console.info(statsMsgs, '\n\ndownload', 'finished.')
          })
        })
      })
    })
    .error(er => cb(er))
  })
}

function processDependencies(manifest, opts) {
  // opts.shrinkwrap==true indicates that this processing is for a dependency
  // listed in a shrinkwrap file, where the entire tree of dependencies is
  // iterated; therefore no dependency recursion should happen.
  if (opts.shrinkwrap)
    return BB.resolve([])

  // IMPORTANT NOTE about scripts.prepare...
  // We don't have to worry about the devDependencies required for scripts.prepare,
  // because it only applies in the case of package type 'git', and it's already
  // handled by pacote when it calls pack() for the local clone of the repo.
  const bundleDeps = manifest.bundleDependencies || {}
  const resolvedDeps = []
  const optionalSet = new Set()

  if (manifest._shrinkwrap && !cmdOpts.noShrinkwrap) {
    const shrDeps = manifest._shrinkwrap.dependencies || {}
    for (let name in shrDeps) {
      let dep = shrDeps[name]
      if (bundleDeps[name]) continue // No need to fetch a bundled package
      // Cases in which we're not interested in devDependencies:
      if (dep.dev && (!opts.topLevel || cmdOpts.IGNORE_DEV_DEPS))
        continue
      // When user said --no-optional
      if (dep.optional && cmdOpts.noOptional)
        continue
      // Cases in which we (might) want devDependencies:
      // cull items that are not devDependencies of a top-level package
      if (!opts.topLevel || (cmdOpts.onlyDev && !(dep.dev || isDevDep(name, dep.version, manifest))))
        continue

      const pkgId = `${name}@${dep.version}`
      resolvedDeps.push(pkgId)
      if (dep.optional) optionalSet.add(pkgId)
    }
    return BB.map(resolvedDeps, function(spec) {
      return processItem(spec, { shrinkwrap: true })
      .then(arr => xformResult(arr))
      .catch(err => {
        if (optionalSet.has(spec)) {
          return [{ spec: spec, failedOptional: true }]
        }
        throw err
      })
    })
  }
  else { // either no shrinkwrap in this manifest, or no-shrinkwrap option was given
    if (opts.topLevel && !cmdOpts.IGNORE_DEV_DEPS) {
      const devDeps = manifest.devDependencies || {}
      for (let name in devDeps) {
        if (!bundleDeps[name])
          resolvedDeps.push(`${name}@${devDeps[name]}`)
      }
    }
    if (!cmdOpts.onlyDev) {
      if (!cmdOpts.noOptional) {
        const optDeps = manifest.optionalDependencies || {}
        for (let name in optDeps) {
          if (!bundleDeps[name]) {
            const pkgId = `${name}@${optDeps[name]}`
            resolvedDeps.push(pkgId)
            optionalSet.add(pkgId)
          }
        }
      }
    }
    // Ensure we get regular deps of devDeps if --only=dev,
    // as well as regular deps of everything if *not* --only=dev
    if (!opts.topLevel || !cmdOpts.onlyDev) {
      const regDeps = manifest.dependencies || {}
      for (let name in regDeps) {
        if (!bundleDeps[name])
          resolvedDeps.push(`${name}@${regDeps[name]}`)
      }
    }
    return BB.map(resolvedDeps, function(spec) {
      return processItem(spec)
      .then(arr => xformResult(arr))
      .catch(err => {
        if (optionalSet.has(spec)) {
          return [{ spec: spec, failedOptional: true }]
        }
        throw err
      })
    })
  }
}

function getItemResultsStats(item, results) {
  const stats = []
  let filtered = results.filter(res => !res.duplicate)
  const dupCount = results.length - filtered.length
  filtered = filtered.filter(res => !res.failedOptional)
  const failedOptCount = (results.length - filtered.length) - dupCount
  if (filtered.length) {
    if (item == 'package.json')
      stats.push(util.format(
        '\nDownloaded tarballs to satisfy %i dependenc%s derived from %s',
        filtered.length, filtered.length == 1 ? 'y' : 'ies', item
      ))
    else
      stats.push(util.format(
        '\nDownloaded tarballs to satisfy %s and %i dependenc%s',
        item, filtered.length - 1, filtered.length == 2 ? 'y' : 'ies'
      ))
  }
  else
    stats.push(util.format('\nNothing new to download for', item))
  if (failedOptCount)
    stats.push(util.format(
      '(failed to fetch %i optional packages)', failedOptCount
    ))
  if (dupCount)
    stats.push(util.format(
      '(%i duplicate spec%s skipped)', dupCount, dupCount > 1 ? 's' : ''
    ))
  return stats.join('\n')
}

function processItem(item, opts) {
  if (!opts) opts = {}

  const p = npa(item)

  let dlType = DlTracker.typeMap[p.type]
  if (!dlType)
    return BB.reject(new RangeError('Cannot download package of type ' + p.type))

  const trackerKeys = { name: p.name, spec: p.rawSpec }
  const result = { spec: item }
  if (p.name) result.name = p.name  // TODO: evaluate if we really need this

  // when p.rawSpec is '', p.type gets set to 'tag' and p.fetchSpec gets set to 'latest' by npa
  if ((p.type === 'tag' && p.fetchSpec === 'latest') ||
      (p.type === 'range' && p.fetchSpec === '*')) {
    dlType = 'semver'
    if (latest[p.name]) {
      result.duplicate = true
      return BB.resolve([ result ])
    }
  }
  else {
    if (p.type === 'git') {
      const gitKeys = gitAux.trackerKeys(p)
      trackerKeys.name = gitKeys.repo
      trackerKeys.spec = gitKeys.spec
    }      
    if (npm.dlTracker.contains(dlType, trackerKeys.name, trackerKeys.spec)) {
      result.duplicate = true
      return BB.resolve([ result ])
    }
  }

  const dlData = {}

  const fetchKey1 = trackerKeys.name ?
    `${trackerKeys.name}:${trackerKeys.spec}` : trackerKeys.spec
  if (inflight[fetchKey1]) {
    result.duplicate = true
    return BB.resolve([ result ])
  }
  inflight[fetchKey1] = true

  let fetchKey2
  let processSpecificType
  if (dlType === 'semver' || dlType === 'tag')
    processSpecificType = processNpmRegistryItem
  else if (dlType === 'git')
    processSpecificType = processGitRepoItem
  else
    processSpecificType = processOtherRemoteItem
  
  return processSpecificType()
  .then(manifest => processDependencies(manifest, opts)
  )
  .then(results => {
    //return dlTracker_addAsync(dlType, dlData)
    // I don't care if the Bluebird author calls this an anti-pattern.
    // I believe it's fully justified in this case.
    // Anyway, eventually I will rewrite the callback-style functions in the
    // DownloadTracker to return promises, and then this will get simplified.
    return new Promise((resolve, reject) => {
      npm.dlTracker.add(dlType, dlData, function(err) {
        err ? reject(err) : resolve(null)
      })
    })
    .then(() => {
      delete inflight[fetchKey2]
      delete inflight[fetchKey1]
      results.push(result)
      return xformResult(results)
    })
  })
  .catch(DuplicateSpecError, function(er) {
    delete inflight[fetchKey1]
    result.duplicate = true
    return [ result ]
  })

/*
References: item, p, latest, result, dlData, dlType, fetchKey2, inflight
*/
  function processNpmRegistryItem() {
    // Get the manifest first, then use that data to configure the download
    return pacote.manifest(item, makeOpts())
    .then(mani => {
      if ((p.type === 'tag' && p.fetchSpec === 'latest') ||
          (p.type === 'range' && p.fetchSpec === '*')) {
        latest[p.name] = mani.version
      }
      result.name = mani.name
      fetchKey2 = `${p.name}:${mani.version}:tarball`
      if (inflight[fetchKey2] ||
          npm.dlTracker.contains('semver', mani.name, mani.version)) {
        throw new DuplicateSpecError(item)
      }
      inflight[fetchKey2] = true

      // Ensure that we never pass a bad value to url.parse or path.basename
      if (!mani._resolved)
        throw new Error(`No _resolved value in manifest for ${item}`)
      if (typeof mani._resolved !== 'string')
        throw new Error(`Invalid _resolved value in manifest for ${item}`)
      const parsedPath = url.parse(mani._resolved).path
      if (typeof parsedPath !== 'string' || parsedPath.trim() === '')
        throw new Error(`Unable to parse a path from _resolved field for ${item}`)

      dlData.name = mani.name
      dlData.version = mani.version
      dlData.filename = npf.makeTarballName({
        type: 'semver', name: mani.name, version: mani.version
      })
      dlData._resolved = mani._resolved
      dlData._integrity = mani._integrity

      if (dlType === 'tag') dlData.spec = p.rawSpec

      const filePath = path.join(npm.dlTracker.path, dlData.filename)
      return pacote.tarball.toFile(
        item, filePath, makeOpts({ resolved: dlData._resolved })
      )
      .then(() => mani)
    })
  }

/*
References: item, p, dlData, result, fetchKey2, inflight, trackerKeys
*/
  function processGitRepoItem() {
    return gitManifest(item, makeOpts({ multipleRefs: true }))
    .then(mani => {
      dlData._resolved = mani._resolved
      if (mani._integrity)
        dlData._integrity = mani._integrity

      result.spec = item
      fetchKey2 = npf.makeTarballName({
        type: 'git',
        domain: p.hosted.domain, path: p.hosted.path(), commit: mani._ref.sha
      })

      if (inflight[fetchKey2] ||
        npm.dlTracker.contains('git', trackerKeys.name, mani._ref.sha)) {
        throw new DuplicateSpecError(item)
      }
      inflight[fetchKey2] = true

      dlData.filename = fetchKey2
      dlData.repo = trackerKeys.name
      dlData.commit = mani._ref.sha
      dlData.refs = mani._ref.allRefs

      const filePath = path.join(npm.dlTracker.path, dlData.filename)
      return pacote.tarball.toFile(
        dlData._resolved, filePath,
        makeOpts({
          //resolved: dlData._resolved, // This causes a cache miss, despite the data being cached from the manifest call
          integrity: dlData._integrity
        })
      )
      .then(() => mani)
    })
  }

/*
References: item, dlData, result, fetchKey2, inflight
*/
  function processOtherRemoteItem() {
    return pacote.manifest(item, makeOpts())
    .then(mani => {
      // If the resolved URL is the same as the requested spec,
      // it would be redundant in the DlTracker data
      if (mani._resolved != item)
        dlData._resolved = mani._resolved
      // TODO: _integrity seems to cause us trouble when we pass it to pacote.tarball.toFile.
      // If it persists in causing trouble, there's no point in saving it in the data.
      //if (mani._integrity) dlData._integrity = mani._integrity

      result.spec = dlData.spec = item
      dlData.filename = npf.makeTarballName({
        type: 'url', url: item
      })

      fetchKey2 = dlData.filename
      if (inflight[fetchKey2] || npm.dlTracker.contains('url', null, item)) {
        throw new DuplicateSpecError(item)
      }
      inflight[fetchKey2] = true

      const filePath = path.join(npm.dlTracker.path, dlData.filename)
      //if (dlData._integrity) opts.integrity = dlData._integrity
      return pacote.tarball.toFile(
        item, filePath, makeOpts({ resolved: dlData._resolved || item })
      )
      .then(() => mani)
    })
  }
}

function makeOpts(extra) {
  const opts = {
    annotate: true,
    hashAlgorithm: 'sha1',
    cache: tempCache,
    log: log
    //memoize: CACHE //???
  }
  if (extra) Object.assign(opts, extra)
  return opts
}

// Adapted from pacote/manifest.js
function gitManifest(spec, opts) {
  spec = npa(spec, opts.where)

  const startTime = Date.now()
  return gitAux.fetchManifest(spec, opts)
  .then(rawManifest => {
    // finalizeManifest removes _ref from the manifest, but we need that here
    const refData = rawManifest._ref
    return finalizeManifest(rawManifest, spec, opts)
    .then(manifest => {
      manifest._ref = refData
      return manifest
    })
  })
  .then(manifest => {
    if (opts.annotate) {
      manifest._from = spec.saveSpec || spec.raw
      manifest._requested = spec
      manifest._spec = spec.raw
    }
    const elapsedTime = Date.now() - startTime
    log.silly(
      'gitManifest',
      `${spec.type} manifest for ${spec.name}@${spec.saveSpec || spec.fetchSpec} fetched in ${elapsedTime}ms`
    )
    return manifest
  })
}
