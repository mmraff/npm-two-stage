const path = require('path')
const readFileAsync = require('util').promisify(require('fs').readFile)

const validate = require('validate-npm-package-name')
const YarnLock = require('./alt-yarn-lock')

const RE_NPM_ALIAS = /^npm:((?:@[^/@]+\/)?[^/@]+)@(.+)$/
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
  // and I've seen an old package-lock that had no lockfileVersion!
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
    for (const name in deps) {
      const src = deps[name]
      const data = { name, version: src.version }
      // If it's a git or remote spec, version is the resolved spec.
      evaluateAlias(data)
      const flags = [ 'dev', 'optional', 'peer' ]
      for (const prop of flags)
        if (src[prop]) data[prop] = true

      // I have yet to find a lockfile in the wild that has the 'bundled'
      // flag on a top-level "dependencies" item - it seems as though it
      // only occurs in items in the nested "dependencies" section of a
      // dependency that bundles - and that does seem to make sense.
      // The only sign of bundling in the metadata of that top-level dep
      // is in its package.json ("bundleDependencies").
      // But I don't have the faith to expect it will never happen, so...
      /* istanbul ignore next */
      if (src.bundled) data.inBundle = true
      results.push(data)
    }
  }
  return results
}

// To gather the dependency data we need from a yarn.lock v1
const fromYarnLock = module.exports.fromYarnLock = yarnText => {
  if (yarnText === undefined || yarnText === null || yarnText === '')
    throw new SyntaxError(argErrMsg)
  if (typeof yarnText !== 'string') throw new TypeError(argErrMsg)

  const results = []
  const yarnObj = YarnLock.parse(yarnText)
  // yarnObj.entries is a Map
  for (const entry of yarnObj.entries) {
    // entry[0] is a spec, such as 'mkdirp@^1.0.2'.
    // entry[1] is a YarnLockEntry object.
    let resolved = entry[1].resolved
    // Watch out for weird entries:
    if (!resolved) continue

    const nameFromSpec = RE_NAME_FROM_SPEC.exec(entry[0])[0]
    const data = { name: nameFromSpec, version: entry[1].version }
    evaluateAlias(data)
    if (RE_YARN_URL.test(resolved)) {
      resolved = resolved.replace(RE_YARN_URL, NPM_REG_URL)
    }
    if (entry[0].endsWith(resolved) || !RE_NPM_URL.test(resolved)) {
      data.version = resolved
    }
    results.push(data)
  }
  return results
}

const readTar = require('./read-from-tarball')

module.exports.extract = (tarball, opts = {}) => {
  // NOTE: readTar does validation of args
  const priorityList = [ 'npm-shrinkwrap.json', 'yarn.lock' ]
  if (opts.packageLock)
    priorityList.splice(1, 0, 'package-lock.json')
  return readTar(tarball, priorityList)
  .then(({ name, content }) =>
    name === 'yarn.lock' ? fromYarnLock(content.toString())
      : fromPackageLock(content.toString())
  )
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
    logger.info('download', 'Error code:', err.code)
    return readFileAsync(path.join(dir, 'package-lock.json'), opts)
    .then(contents => fromPackageLock(contents))
    .catch(err => {
      logger.info('download',
        'Failed to read package-lock.json at given lockfile-dir')
      logger.info('download', 'Error code:', err.code)
      return readFileAsync(path.join(dir, 'yarn.lock'), opts)
      .then(contents => fromYarnLock(contents))
      .catch(err => {
        logger.info('download',
          'Failed to read yarn.lock at given lockfile-dir')
        logger.info('download', 'Error code:', err.code)
        logger.warn('download', 'No usable lockfile at', dir)
        return []
      })
    })
  })
}
