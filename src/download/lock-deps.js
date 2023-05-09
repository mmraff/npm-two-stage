const path = require('path')
const readFileAsync = require('util').promisify(require('fs').readFile)

const validate = require('validate-npm-package-name')
const YarnLock = require('./alt-yarn-lock')
const readTar = require('./read-from-tarball')

const RE_NPM_ALIAS = /\bnpm:((?:@[^/@]+\/)?[^/@]+)@(.+)$/
const RE_PKGNAME_FROM_PATH = /node_modules\/((?:@[^/]+\/)?[^/]+)$/
const RE_NPM_URL = /^https?:\/\/registry\.npmjs\.org\//
const RE_YARN_URL = /^https?:\/\/registry\.yarnpkg\.com\//
const RE_NAME_FROM_SPEC = /^@?[^@]+/
const NPM_REG_URL = 'https://registry.npmjs.org/'

const evaluateAlias = data => {
  const matches = RE_NPM_ALIAS.exec(data.version)
  if (matches && validate(matches[1])) {
    data.name = matches[1]
    data.version = matches[2]
  }
}

const argErrMsg = 'Text from a lock file is required'

const collectDeps_v1 = (deps, resultList) => {
  for (const name in deps) {
    const src = deps[name]
    if (!src.version) continue
    const data = { name, version: src.version }
    // If it's a git or remote spec, version is the resolved spec.
    evaluateAlias(data)
    const flags = [ 'dev', 'optional', 'peer' ]
    for (const prop of flags)
      if (src[prop]) data[prop] = true
    if (src.bundled) data.inBundle = true
    resultList.push(data)
    if (src.dependencies)
      collectDeps_v1(src.dependencies, resultList)
  }
}

// To gather the dependency data we need from a package-lock.json
// or npm-shrinkwrap.json, adapting to versions 1-3
const fromPackageLock = module.exports.fromPackageLock = (lockText) => {
  if (lockText === undefined || lockText === null || lockText === '')
    throw new SyntaxError(argErrMsg)
  if (typeof lockText !== 'string') throw new TypeError(argErrMsg)

  const lockData = JSON.parse(lockText)
  // Removed validation of the contents from here:
  // lockfileVersion 1 can have no 'dependencies' section, and
  // of course has no 'packages' (that's lockfileVersion 2);
  // and I've seen old package-lock files that had no lockfileVersion!
  // What would  be the point of requiring the 'name' and 'version'
  // fields at the top level? So, never mind.
  const results = []
  const pkgs = lockData.packages
  if (pkgs) {
    for (const pkgPath in pkgs) {
      const src = pkgs[pkgPath]
      const matches = RE_PKGNAME_FROM_PATH.exec(pkgPath)
      // NOTE that if !src.resolved, maybe src.inBundle...
      if (!matches || src.link || !src.version || !src.resolved)
        continue
      const data = { name: matches[1], version: src.version }
      evaluateAlias(data)
      // "registry.yarnpkg.com" resolved values have been seen in the wild!
      if (RE_YARN_URL.test(src.resolved)) {
        src.resolved = src.resolved.replace(RE_YARN_URL, NPM_REG_URL)
      }
      if (!RE_NPM_URL.test(src.resolved)) {
        data.version = src.resolved
      }
      const flags = [ 'dev', 'optional', 'devOptional', 'peer', 'inBundle' ]
      for (const prop of flags)
        if (src[prop]) data[prop] = true
      results.push(data)
    }
  }
  else {
    const deps = lockData.dependencies || {}
    collectDeps_v1(deps, results)
  }
  return results
}

// To gather the dependency data we need from a yarn.lock v1.
// This function has lately become bloated with multiple Sets and Maps
// and nested functions, etc., because we must do extra work, simply for
// the fact that a yarn.lock v1 is so deficient in information:
// * it does not distinguish devDependency items from regular dependencies;
// * it does not have any feature that flags items as 'peer', 'optional',
//   or 'dev'
// * the only way to establish the heirarchy of relationships between the
//   items is to follow from the dependencies list of an item, where such
//   can be found
//   (and then there's only 'dependencies' and 'optionalDependencies')
// So we must consult an accompanying package.json, then recursively iterate
// the dependencies as listed in the yarn.lock, keeping track of which
// category(ies) each falls into, so that we can flag them appropriately
// in the output data.
const fromYarnLock = module.exports.fromYarnLock = (yarnText, pkg) => {
  if (yarnText === undefined || yarnText === null || yarnText === '')
    throw new SyntaxError(argErrMsg)
  if (typeof yarnText !== 'string') throw new TypeError(argErrMsg)
  const pkgErrMsg = 'A package manifest is required'
  if (pkg === undefined || pkg === null || pkg === '')
    throw new SyntaxError(pkgErrMsg)
  if (typeof pkg !== 'object') throw new TypeError(pkgErrMsg)

  const results = []
  const yarnObj = YarnLock.parse(yarnText)
  const regDepSet = new Set()
  const optDepSet = new Set()
  const peerDepSet = new Set()
  const devDepSet = new Set()
  const devOptSet = new Set()
  const optDevDepSet = new Set()
  const reverseMap = new Map()
  const topRegDeps = pkg.dependencies || {}
  const topOptDeps = pkg.optionalDependencies || {}
  const topPeerDeps = pkg.peerDependencies || {}
  const topDevDeps = pkg.devDependencies || {}
  const bundleDeps = pkg.bundleDependencies || pkg.bundledDependencies || []
  // NOTE - use of yarn for a project with bundleDependencies seems to be
  // notoriously troublesome (consider: the same version of a package can be
  // both bundled and a transitive dependency of something not bundled);
  // and the advice from the yarn maintainers is: Don't bundle dependencies.
  // So what we'll do here is skip the dependencies listed as bundled in
  // package.json; then, as we iterate the yarn.lock entries, filter out
  // anything that has not been categorized, instead of flagging inBundle.

  const resolveSpec = spec => {
    const entry = yarnObj.entries.get(spec)
    if (!entry) return null

    let resolved = entry.resolved
    // Watch out for weird entries:
    if (!resolved) return null

    const nameFromSpec = RE_NAME_FROM_SPEC.exec(spec)[0]
    const data = { name: nameFromSpec, version: entry.version }
    // We don't use evaluateAlias here because it doesn't search in the
    // right place for this situation:
    const matches = RE_NPM_ALIAS.exec(spec)
    if (matches && validate(matches[1])) {
      data.name = matches[1]
    }
    if (RE_YARN_URL.test(resolved)) {
      resolved = resolved.replace(RE_YARN_URL, NPM_REG_URL)
    }
    if (spec.endsWith(resolved) || !RE_NPM_URL.test(resolved)) {
      data.version = resolved
    }
    return data
  }

  const collectDeps = (spec, mySet, filter) => {
    const idData = resolveSpec(spec)
    if (!idData) return
    const resolvedSpec = idData.name + '@' + idData.version
    if (mySet.has(resolvedSpec)) return // Avoid cyclical recursion!!!
    if (filter && !filter(resolvedSpec)) return
    mySet.add(resolvedSpec)
    reverseMap.set(resolvedSpec, spec)
    // The following will always get something, because it gets called in
    // resolveSpec(); if it got nothing there, we don't reach this line
    const entry = yarnObj.entries.get(spec)
    const deps = entry.dependencies
    if (deps) {
      for (const depName in deps) {
        const depSpec = depName + '@' + deps[depName]
        collectDeps(depSpec, mySet, filter)
      }
    }
  }
  // Walk the optionalDependencies of the record for the given spec, and
  // collect them and their regular dependencies.
  // NOT to be used on devDependencies - that needs a custom approach.
  const collectOptDeps = (spec, alsoPeer) => {
    const origSpec = reverseMap.get(spec)
    const entry = yarnObj.entries.get(origSpec)
    const optDeps = entry.optionalDependencies
    if (optDeps) {
      for (const name in optDeps) {
        const depSpec = name + '@' + optDeps[name]
        collectDeps(
          depSpec, optDepSet,
          arg => (!regDepSet.has(arg) && !peerDepSet.has(arg))
        )
        if (alsoPeer)
          collectDeps(depSpec, peerDepSet, arg => !regDepSet.has(arg))
      }
    }
  }
  const collectDevDeps = spec => {
    const idData = resolveSpec(spec)
    if (!idData) return
    const resolvedSpec = idData.name + '@' + idData.version
    if (devDepSet.has(resolvedSpec)) return // Avoid cyclical recursion
    if (regDepSet.has(resolvedSpec) || peerDepSet.has(resolvedSpec)) return
    if (optDepSet.has(resolvedSpec)) {
      // This will result in duplicates of items in optDepSet, but later we
      // will check devOptSet while iterating optDepSet to determine whether
      // to mark a record as optional or devOptional
      collectDeps(
        spec, devOptSet,
        arg => (!regDepSet.has(arg) && !peerDepSet.has(arg))
      )
      return
    }
    devDepSet.add(resolvedSpec)
    reverseMap.set(resolvedSpec, spec)
    const entry = yarnObj.entries.get(spec)
    const deps = entry.dependencies
    if (deps) {
      for (const depName in deps) {
        const depSpec = depName + '@' + deps[depName]
        collectDevDeps(depSpec)
      }
    }
  }
  const collectOptDevDeps = spec => { // Not to be confused with devOpts
    const idData = resolveSpec(spec)
    if (!idData) return
    const resolvedSpec = idData.name + '@' + idData.version
    if (optDevDepSet.has(resolvedSpec)) return // Avoid cyclical recursion
    if (regDepSet.has(resolvedSpec) || peerDepSet.has(resolvedSpec)
      || optDepSet.has(resolvedSpec)
      || devDepSet.has(resolvedSpec) || devOptSet.has(resolvedSpec))
      return

    optDevDepSet.add(resolvedSpec)
    reverseMap.set(resolvedSpec, spec)
    const entry = yarnObj.entries.get(spec)
    const deps = entry.dependencies
    if (deps) {
      for (const depName in deps) {
        const depSpec = depName + '@' + deps[depName]
        collectOptDevDeps(depSpec)
      }
    }
  }

  for (const name in topRegDeps) {
    if (bundleDeps.includes(name)) continue
    const spec = name + '@' + topRegDeps[name]
    collectDeps(spec, regDepSet)
  }
  for (const name in topPeerDeps) {
    if (bundleDeps.includes(name)) continue
    const spec = name + '@' + topPeerDeps[name]
    collectDeps(spec, peerDepSet, arg => !regDepSet.has(arg))
  }
  for (const name in topOptDeps) {
    if (bundleDeps.includes(name)) continue
    const spec = name + '@' + topOptDeps[name]
    collectDeps(
      spec, optDepSet,
      arg => (!regDepSet.has(arg) && !peerDepSet.has(arg))
    )
  }

  // npm documentation for package-lock.json says one thing;
  // but when it writes that file, npm behavior is a very different thing.
  // Here we follow the example of npm behavior instead of the doc:
  for (const spec of regDepSet) collectOptDeps(spec)
  for (const spec of peerDepSet) collectOptDeps(spec, true)
  for (const spec of optDepSet) collectOptDeps(spec)

  for (const name in topDevDeps) {
    if (bundleDeps.includes(name)) continue
    collectDevDeps(name + '@' + topDevDeps[name])
  }
  // Re-iterate the devDeps, collecting their optional deps
  for (const spec of devDepSet) {
    const origSpec = reverseMap.get(spec)
    const entry = yarnObj.entries.get(origSpec)
    const optDeps = entry.optionalDependencies
    if (!optDeps) continue
    for (const name in optDeps) {
      const depSpec = name + '@' + optDeps[name]
      collectOptDevDeps(depSpec)
    }
  }
  // Re-iterate the optional deps of devDeps, collecting their optional deps
  for (const spec of optDevDepSet) {
    const origSpec = reverseMap.get(spec)
    const entry = yarnObj.entries.get(origSpec)
    const optDeps = entry.optionalDependencies
    if (!optDeps) continue
    for (const name in optDeps) {
      const depSpec = name + '@' + optDeps[name]
      collectOptDevDeps(depSpec)
    }
  }

  // Now that we have all the expected entries categorized, we can iterate
  // the list and apply the appropriate flag(s)
  for (const entry of yarnObj.entries) {
    // yarnObj.entries is a Map - when iterated,
    //   entry[0] is a spec, such as 'mkdirp@^1.0.2';
    //   entry[1] is a YarnLockEntry object.
    const spec = entry[0]
    const data = resolveSpec(spec)
    if (!data) continue

    const resolvedSpec = data.name + '@' + data.version
    // The following causes duplicates to be skipped; it also skips
    // yarn.lock entries that can't be traced back to the top-level deps
    // of the package.json (reverseMap.get will return undefined for such):
    if (reverseMap.get(resolvedSpec) != spec) continue
    if (!regDepSet.has(resolvedSpec)) {
      if (peerDepSet.has(resolvedSpec)) {
        data.peer = true
      }
      if (devOptSet.has(resolvedSpec)) {
        data.devOptional = true
      }
      else if (optDevDepSet.has(resolvedSpec)) {
        data.dev = data.optional = true
      }
      else if (optDepSet.has(resolvedSpec)) {
        data.optional = true
      }
      else if (devDepSet.has(resolvedSpec)) {
        data.dev = true
      }
    }
    results.push(data)
  }
  return results
}

const parsePkgJsonContent = content => {
  let s = content.toString()
  /* istanbul ignore next: a tried-and-true pattern, not worth the trivial test */
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1)
  try {
    return JSON.parse(s)
  }
  catch (err) {
    err = Object.assign(
      new Error('Failed to parse package.json: ' + err.message),
      { code: 'EJSONPARSE' }
    )
    throw err
  }
}

module.exports.extract = (tarball, opts = {}) => {
  // NOTE: readTar does validation of args
  const priorityList = [ 'npm-shrinkwrap.json', 'yarn.lock' ]
  if (opts.packageLock)
    priorityList.splice(1, 0, 'package-lock.json')
  return readTar(tarball, priorityList)
  .then(({ name, content }) => {
    if (name === 'yarn.lock') {
      // A yarn.lock doesn't distinguish dev deps from production deps.
      // An accompanying package.json is needed for guidance.
      const yarnText = content
      return readTar(tarball, [ 'package.json' ])
      .catch(err => {
        /* istanbul ignore else: other errors are beyond our scope here */
        if (err.code === 'ENOMATCH') {
          err = Object.assign(
            new Error('Package has no package.json: ' + tarball),
            { code: 'ENOPACKAGEJSON' }
          )
        }
        throw err
      })
      .then(({ name, content }) => {
        const pkg = parsePkgJsonContent(content)
        return fromYarnLock(yarnText.toString(), pkg)
      })
    }
    else return fromPackageLock(content.toString())
  })
  .catch(err => {
    if (err.code === 'ENOMATCH') return []
    throw err
  })
}

module.exports.readFromDir = (dir, logger) => {
  const dirErrMsg = 'Path where lock file(s) can be found is required'
  if (dir === undefined || dir === null || dir === '')
    return Promise.reject(new SyntaxError(dirErrMsg))
  if (typeof dir !== 'string')
    return Promise.reject(new TypeError(dirErrMsg))
  if (!logger) {
    logger = { info: () => {}, warn: () => {} }
  }

  const opts = { encoding: 'utf8' }
  return readFileAsync(path.join(dir, 'npm-shrinkwrap.json'), opts)
  .then(contents => fromPackageLock(contents))
  .catch(err => {
    logger.info('download',
      'Failed to read npm-shrinkwrap.json at given lockfile-dir')
    /* istanbul ignore next */
    if (err.code) logger.info('download', 'Error code:', err.code)
    return readFileAsync(path.join(dir, 'package-lock.json'), opts)
    .then(contents => fromPackageLock(contents))
    .catch(err => {
      logger.info('download',
        'Failed to read package-lock.json at given lockfile-dir')
      /* istanbul ignore next */
      if (err.code) logger.info('download', 'Error code:', err.code)
      return readFileAsync(path.join(dir, 'yarn.lock'), opts)
      .catch(err => {
        logger.info('download',
          'Failed to read yarn.lock at given lockfile-dir')
        /* istanbul ignore next */
        if (err.code) logger.info('download', 'Error code:', err.code)
        throw err
      })
      .then(contents =>
        readFileAsync(path.join(dir, 'package.json'), opts)
        .catch(err => {
          logger.warn('download',
            'Failed to read package.json at given lockfile-dir')
          /* istanbul ignore next */
          if (err.code) logger.warn('download', 'Error code:', err.code)
          logger.warn('download',
            'A package.json is required to aid in processing a yarn.lock')
          throw err
        })
        .then(content => {
          const pkg = parsePkgJsonContent(content)
          return fromYarnLock(contents, pkg)
        })
      )
      .catch(err => {
        logger.warn('download', err.message)
        logger.warn('download', 'No usable lockfile at', dir)
        return []
      })
    })
  })
}
