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
const finalizeManifest = require('pacote/lib/finalize-manifest')
const log = require('npmlog')
const mkdirpAsync = util.promisify(require('mkdirp'))
const npa = require('npm-package-arg')
const pacote = require('pacote')
const rimraf = require('rimraf')
const semver = require('semver')
const validate = require('aproba')

// npm internal utils
const DlTracker = require("./download/dltracker.js")
const gitAux = require('./download/git-aux')
const npf = require('./download/npm-package-filename')
const npm = require('./npm.js')

const cmdOpts = {}
const latest = {}
const inflight = {}

const tempCache = path.join(npm.tmp, 'dl-temp-cache')

function DuplicateSpecError() {}
DuplicateSpecError.prototype = Object.create(Error.prototype)

// Tame those nested arrays
function xformResult(res) {
  return res.reduce((acc, val) => acc.concat(val), [])
}

function download (args, cb) {
  validate('AF', [args, cb])

  log.silly('download', 'args:', args)

  // Should be able to give different command options to subsequent calls
  // in the same session (this becomes important in testing):
  for (let prop in cmdOpts) delete cmdOpts[prop]

  const optPj = npm.config.get('package-json') || npm.config.get('pj') || npm.config.get('J')
  if (optPj) {
    cmdOpts.packageJson = typeof optPj == 'boolean' ? process.cwd() : path.resolve(optPj)
    if (cmdOpts.packageJson.endsWith(path.sep + 'package.json'))
      cmdOpts.packageJson = path.dirname(cmdOpts.packageJson)
  }

  if (!(cmdOpts.packageJson || (args && args.length > 0))) {
    return cb(new SyntaxError([
      'No packages named for download.',
      'Maybe you want to use the package-json option?',
      'Try: npm download -h'
    ].join('\n')))
  }

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

    const operations = []
    mkdirpAsync(tempCache)
    .then(() => {
      npm.dlTracker = newTracker
      let statsMsgs = ''
      const pjPromise = !cmdOpts.packageJson ? Promise.resolve([]) :
        pacote.manifest(cmdOpts.packageJson).then(mani => {
          return processDependencies(mani, { topLevel: true })
          .then(results => {
            const pjResults = xformResult(results)
            statsMsgs = getItemResultsStats('package.json', pjResults)
            return pjResults
          })
        })

      return pjPromise.then(pjResults => {
        for (const item of args) {
          operations.push(
            processItem(item, { topLevel: true })
            .then(results => {
              statsMsgs += getItemResultsStats(item, results)
              return results
            })
          )
        }
        return (operations.length ?
          Promise.all(operations).then(results => {
            if (pjResults.length) results.unshift(pjResults)
            return results
          }) : [ pjResults ]
        )
      })
      .then(results => {
        // results is an array of arrays, 1 for each spec on the command line.
        rimraf(tempCache, function(rimrafErr) {
          /* istanbul ignore if */
          if (rimrafErr)
            log.warn('download', 'failed to delete the temp dir ' + tempCache)

          newTracker.serialize(function(serializeErr) {
            // The console call follows the callback call here because when
            // placed before, it causes a stutter in the npm log output.
            cb(serializeErr, results)
// TODO: This is not acceptable. Go back to using the log, verify the stutter,
// and try to find a different way around it.
            //console.info(statsMsgs, '\n\ndownload', 'finished.')
            log.http('', statsMsgs, '\n\ndownload', 'finished.')
          })
        })
      })
    })
    .catch(err => cb(err))
  })
}

// Determines if the package identified by the given dependency data
// satisfies the given spec.
// depData is a record from any "dependencies" section in the package-lock
// or shrinkwrap file.
//
function satisfiesSpec(depData, spec) {
  // By experiment, have determined that npm never allows a tag to get into a
  // package-lock/shrinkwrap; even if the tag is in the dependency spec in
  // the package.json, it always gets resolved to the semver version in the
  // package-lock's "dependencies" record, and to the range spec formed by
  // prefixing that with '^' in the "requires" listing.
  const ver = depData.version
  if (ver == spec) return true // easiest case
  const npaSpec = npa(spec)
  switch (npaSpec.type) {
    case 'range':
      return !!semver.valid(ver) && semver.satisfies(ver, spec)
    case 'git':
      // Though apparently not documented, I have seen that a git dependency
      // record in a shrinkwrap always has a 'from' property that matches
      // the spec in the package.json dependency listing:
      return depData.from == spec
  }
  return false
}

/*
  Specifically to deal with the case of a development dependency that is also
  a transitive dependency of a top-level devDependency, because otherwise,
  such an item will not be flagged "dev", and will be skipped when --only=dev
  is given and we have a shrinkwrap.
  If this is called on a given item, then we know that the package is wanted -
  no need to cull anything.
*/
// Iterate and recurse into the "requires" listings of a dependency in a
// package-lock/npm-shrinkwrap file, collecting the transitive dependency
// specs into depMap.  depsStack enables us out to "walk out" through
// ancestral dependency lists for matches.
//
function walkRequires(itemDef, depsStack, depMap, opts) {
  if (!itemDef.requires) return

  /* istanbul ignore if: does not merit extra test */
  if (!opts) opts = {}
  if (itemDef.dependencies) depsStack.push(itemDef.dependencies)
  for (let name in itemDef.requires) {
    let stackIdx = depsStack.length
    let found
    do {
      --stackIdx
      const depDefDeps = depsStack[stackIdx]
      if (!(name in depDefDeps)) continue
      if ((depDefDeps[name].optional && opts.noOptional)
          || depDefDeps[name].bundled) {
        found = true
        break
      }
      if (satisfiesSpec(depDefDeps[name], itemDef.requires[name])) {
        found = true
        if (!(name in depMap)) depMap[name] = new Set()
        depMap[name].add(depDefDeps[name].version)
        walkRequires(depDefDeps[name], depsStack, depMap, opts)
        break
      }
    } while (stackIdx > 0)
    /* istanbul ignore if: can only reproduce with a broken shrinkwrap */
    if (!found) {
console.log('WARNING: exhausted dependency list(s); did not find specific version')
console.log(`  to satisfy spec ${name}@${itemDef.requires[name]}`)
      // TODO: some way to get an error/warning to the user
    }
  }
}

function processDependencies(manifest, opts) {
  // opts.shrinkwrap==true indicates that this processing is for a dependency
  // listed in a shrinkwrap file, where the entire tree of dependencies is
  // iterated; therefore no dependency recursion should happen.
  if (opts.shrinkwrap)
    return Promise.resolve([])

  // IMPORTANT NOTE about scripts.prepare...
  // We don't have to worry about the devDependencies required for scripts.prepare,
  // because it only applies in the case of package type 'git', and it's already
  // handled by pacote when it calls pack() for the local clone of the repo.

  const optionalSet = new Set()
  const operations = []

  if (manifest._shrinkwrap && !cmdOpts.noShrinkwrap) {
    const depMap = {}
    /* istanbul ignore next: shrinkwrap without dependencies does not merit extra test */
    const shrDeps = manifest._shrinkwrap.dependencies || {}
    for (const name in shrDeps) {
      const dep = shrDeps[name]
      if (dep.bundled) continue // No need to fetch a bundled package
      // Cases in which we're not interested in devDependencies:
      if (dep.dev && (!opts.topLevel || cmdOpts.IGNORE_DEV_DEPS))
        continue
      // When user said --no-optional
      if (dep.optional && cmdOpts.noOptional)
        continue
      // Cases in which we (might) want devDependencies:
      // cull items that are not devDependencies of a top-level package.
      // There are 2 cases in which a devDependency is *not* marked as such in a
      // shrinkwrap file: the package in question is
      //  * "both a development dependency of the top level and a transitive
      //    dependency of a non-development dependency of the top level"
      //  * both a non-dev dependency of the top level and a transitive dependency
      //    of a devDependency.
      const maniDevDeps = manifest.devDependencies
      const isSurelyDevDep = dep.dev || (maniDevDeps && (name in maniDevDeps))
      if (!opts.topLevel || (cmdOpts.onlyDev && !isSurelyDevDep))
        continue

      if (!(name in depMap)) depMap[name] = new Set()
      depMap[name].add(dep.version)
      walkRequires(dep, [ shrDeps ], depMap, { noOptional: cmdOpts.noOptional })

      if (dep.optional) optionalSet.add(`${name}@${dep.version}`)
    }
    for (const name in depMap) {
      const versionSet = depMap[name]
      for (const ver of versionSet) {
        const spec = `${name}@${ver}`
        operations.push(
          processItem(spec, { shrinkwrap: true })
          .then(arr => xformResult(arr))
          .catch(err => {
            if (optionalSet.has(spec)) {
              return [{ spec: spec, failedOptional: true }]
            }
            throw err
          })
        )
      }
    }
    return Promise.all(operations)
  }
  else { // No shrinkwrap in this manifest, or no-shrinkwrap option given
    const regDeps = manifest.dependencies || {}
    /* istanbul ignore next: no devDependencies case does not merit extra test */
    const devDeps = manifest.devDependencies || {}
    const optDeps = manifest.optionalDependencies || {}

    // "bundleDependencies" is the property name enforced by the Manifest
    // class in pacote finalize-manifest.js; however, it does not enforce an
    // array value - a value of true is allowed (and probably other things).
    // For that case, see method allDepsBundled of package 'npm-bundled' for
    // validation of the approach used below.
    const manifestBundled = manifest.bundleDependencies
    const bundleDeps =
      manifestBundled && (typeof manifestBundled == 'boolean')
      ? new Set(Object.keys(regDeps).concat(Object.keys(optDeps)))
      : new Set(Array.isArray(manifestBundled) ? manifestBundled : [])

    const resolvedDeps = []
    if (opts.topLevel && !cmdOpts.IGNORE_DEV_DEPS) {
      for (let name in devDeps) {
        if (!bundleDeps.has(name))
          resolvedDeps.push(`${name}@${devDeps[name]}`)
      }
    }
    if (!cmdOpts.onlyDev && !cmdOpts.noOptional) {
      for (let name in optDeps) {
        if (!bundleDeps.has(name)) {
          const pkgId = `${name}@${optDeps[name]}`
          resolvedDeps.push(pkgId)
          optionalSet.add(pkgId)
        }
      }
    }
    // Ensure we get regular deps of devDeps if --only=dev,
    // as well as regular deps of everything if *not* --only=dev
    if (!opts.topLevel || !cmdOpts.onlyDev) {
      for (let name in regDeps) {
        if (!bundleDeps.has(name))
          resolvedDeps.push(`${name}@${regDeps[name]}`)
      }
    }
    for (const spec of resolvedDeps) {
      operations.push(
        processItem(spec)
        .then(arr => xformResult(arr))
        .catch(err => {
          if (optionalSet.has(spec)) {
            return [{ spec: spec, failedOptional: true }]
          }
          throw err
        })
      )
    }
    return Promise.all(operations)
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
        filtered.length,
        /* istanbul ignore next: does not merit extra test */
        filtered.length == 1 ? 'y' : 'ies', item
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
      '(%i duplicate spec%s skipped)', dupCount,
      /* istanbul ignore next: does not merit extra test */
      dupCount > 1 ? 's' : ''
    ))
  return stats.join('\n')
}

function processItem(item, opts) {
  if (!opts) opts = {}

  const p = npa(item)

  let dlType = DlTracker.typeMap[p.type]
  if (!dlType)
    return Promise.reject(new Error('Cannot download package of type ' + p.type))

  const trackerKeys = { name: p.name, spec: p.rawSpec }
  const result = { spec: item }
  if (p.name) result.name = p.name  // TODO: evaluate if we really need this

  // when p.rawSpec is '', p.type gets set to 'tag' and p.fetchSpec gets set to 'latest' by npa
  if ((p.type === 'tag' && p.fetchSpec === 'latest') ||
      (p.type === 'range' && p.fetchSpec === '*')) {
    dlType = 'semver'
    if (latest[p.name]) {
      result.duplicate = true
      return Promise.resolve([ result ])
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
      return Promise.resolve([ result ])
    }
  }

  const dlData = {}

  const fetchKey1 = trackerKeys.name ?
    `${trackerKeys.name}:${trackerKeys.spec}` : trackerKeys.spec
  if (inflight[fetchKey1]) {
    result.duplicate = true
    return Promise.resolve([ result ])
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
  .then(manifest => processDependencies(manifest, opts))
  .then(results => {
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
  .catch(err => {
    delete inflight[fetchKey2]
    delete inflight[fetchKey1]
    if (err instanceof DuplicateSpecError) {
      result.duplicate = true
      return [ result ]
    }
    throw err
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
      /* istanbul ignore next */
      if (mani._integrity)
        dlData._integrity = mani._integrity

      result.spec = item
      fetchKey2 = npf.makeTarballName({
        type: 'git',
        domain: p.hosted.domain, path: p.hosted.path(), commit: mani._ref.sha
      })

      /* istanbul ignore if: given the prior duplicate spec checks above,
         I don't know whether the inside of this will ever be reachable */
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
      /* istanbul ignore next */
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
      /* istanbul ignore if: another case where we're probably boxed out by
        prior duplicate spec checks */
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
//console.log('gitManifest called with spec', spec)
  spec = npa(spec, opts.where)
//console.log('... which then gets converted to npaSpec', spec)

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
    /* istanbul ignore else: we always annotate here (see makeOpts above),
      but we want this code to have as close a resemblance as possible to the
      upstream source, for the sake of an easy diff when we need that
    */
    if (opts.annotate) {
      /* istanbul ignore next: we don't care about this little case of branching */
      manifest._from = spec.saveSpec || spec.raw
      manifest._requested = spec
      manifest._spec = spec.raw
    }
    /* istanbul ignore next: we don't care about this little case of branching */
    const displaySpec = spec.saveSpec || spec.fetchSpec
    const elapsedTime = Date.now() - startTime
    log.silly(
      'gitManifest',
      `${spec.type} manifest for ${spec.name}@${displaySpec} fetched in ${elapsedTime}ms`
    )
    return manifest
  })
}
