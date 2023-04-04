// built-ins
const path = require('path')
const url = require('url')
const promisify = require('util').promisify

// 3rd party dependencies
const fs = require('graceful-fs')
const semver = require('semver')
const npf = require('./npm-package-filename') // CHANGED from '@offliner/npm-package-filename'

const reconstructMap = require('./reconstruct-map')

const lstatAsync = promisify(fs.lstat)
const readFileAsync = promisify(fs.readFile)
const writeFileAsync = promisify(fs.writeFile)

const dummyFunc = () => {}
const dummyLog = {
  error: dummyFunc, warn: dummyFunc, info: dummyFunc, verbose: dummyFunc
}

const NPA_TO_DLT_TYPE_MAP = { // for external use
  version: 'semver',
  range: 'semver',
  tag: 'tag',
  remote: 'url',
  git: 'git'
}
Object.freeze(NPA_TO_DLT_TYPE_MAP)
module.exports.typeMap = NPA_TO_DLT_TYPE_MAP
module.exports.create = create

const DLT_TYPES = new Set([ // internal
  'git', 'semver', 'tag', 'url'
])
const KEYFIELDS = new Set([ // internal
  'type', 'name', 'version', 'spec', 'repo', 'commit'
])

const RE_HEX40 = /^[a-f0-9]{40}$/ // git commit hash pattern
const MAPFILE_NAME = 'dltracker.json'
const MAPFILE_DESC_FIELD = [
  'This file is an artifact of the command **npm download**.  ',
  'It enables **npm install --offline** to map package specs to ',
  'installation-related metadata and corresponding tarball files.  ',
  'DO NOT DELETE this file.  Ensure that it travels with the files in the ',
  'shared directory, until you have followed up with the command ',
  '**npm install --offline** and have verified a good installation.'
].join('')

function auditOne(type, data, dir) {
  let fileSpec = data.filename
  if (!fileSpec) {
    const err = new Error('No filename in data')
    err.code = 'ENODATA'
    return Promise.reject(err)
  }
  const filePath = path.resolve(dir, fileSpec)
  return lstatAsync(filePath).then(stats => {
    let err
    if (!stats.isFile()) {
      err = new Error('Not a regular file')
      err.code = 'EFNOTREG'
      err.path = filePath
    }
    else if (!stats.size) {
      err = new Error('File of zero length')
      err.code = 'EFZEROLEN'
      err.path = filePath
    }
    else if(!npf.hasTarballExtension(fileSpec)) {
      err = new Error('File does not have a tarball extension')
      err.code = 'EFNAME'
      err.path = filePath
    }
    if (err) throw err
  })
}

// Argument validation

function expectNonemptyString(val, valName) {
  if (val === undefined || val === null || val === '')
    throw new SyntaxError('package ' + valName + ' required')
  if (typeof val !== 'string')
    throw new TypeError('package ' + valName + ' must be given as a string')
}

function expectDLTType(val) {
  if (val === undefined || val === null || val === '')
    throw new SyntaxError('package type required')
  if (typeof val !== 'string')
    throw new TypeError('package type must be given as a string')
  if (!DLT_TYPES.has(val))
    throw new RangeError('given package type "' + val + '" unrecognized')
}

function expectPackageData(type, data) {
  if (typeof data !== 'object')
    throw new TypeError('package metadata must be an object')
  // The one field that every package metadata must have (for version > 1):
  if (!data.filename)
    throw new SyntaxError('package metadata must include a filename')
  if (typeof data.filename !== 'string')
    throw new TypeError('filename must be a string')

  switch (type) {
    case 'tag':
      if (!('spec' in data))
        throw new SyntaxError("tag-type metadata must include tag name")
      if (typeof data.spec !== 'string')
        throw new TypeError("tag name must be a string")
      if (!data.spec.trim())
        throw new SyntaxError("tag name must be a non-empty string")
    case 'semver':
      if (!('name' in data))
        throw new SyntaxError(`${type}-type metadata must include package name`)
      if (typeof data.name !== 'string')
        throw new TypeError("package name must be a string")
      if (!data.name.trim())
        throw new SyntaxError("package name must be a non-empty string")

      if (!('version' in data))
        throw new SyntaxError(`${type}-type metadata must include version`)
      if (typeof data.version !== 'string')
        throw new TypeError("version spec must be a string")
      if (!data.version.trim())
        throw new SyntaxError("version spec must be a non-empty string")
      break;
    case 'git':
      if (!('repo' in data))
        throw new SyntaxError("git-type metadata must include repo spec")
      if (typeof data.repo !== 'string')
        throw new TypeError("git repo spec must be a string")
      if (!data.repo.trim())
        throw new SyntaxError("git repo spec must be a non-empty string")

      if (!('commit' in data))
        throw new SyntaxError("git-type metadata must include commit hash")
      if (typeof data.commit !== 'string')
        throw new TypeError("git commit must be a string")
      if (!RE_HEX40.test(data.commit))
        throw new SyntaxError("git commit must be a 40-character hex string")

      if ('refs' in data) {
        if (!Array.isArray(data.refs))
          throw new TypeError("git-type metadata property 'refs' must be an array")
        if (!data.refs.length) {
          throw new SyntaxError("git-type metadata refs must contain at least one tag")
        }
        for (let refIdx = 0; refIdx < data.refs.length; ++refIdx) {
          if (typeof data.refs[refIdx] != 'string')
            throw new TypeError("git ref must be a string")
          if (!data.refs[refIdx].trim())
            throw new SyntaxError("git ref must be a non-empty string")
        }
      }
      break;
    case 'url':
      if (!('spec' in data))
        throw new SyntaxError("url-type metadata must include URL")
      if (typeof data.spec !== 'string')
        throw new TypeError("URL must be a string")
      if (!data.spec.trim())
        throw new SyntaxError("url spec must be a non-empty string")
      break;
  }
}

// Factory
// Can be called in any of the following forms:
//   create()
//   create(undefined) || create(null) || create('')
//   create(where)
//   create(<undefined||null||''||where>, undefined)
//   create(<undefined||null||''||where>, null)
//   create(<undefined||null||''||where>, opts)
function create(where, opts) {
  try {
    if (where !== undefined && where !== null) {
      if (typeof where !== 'string')
        throw new TypeError('path must be given as a string')
    }
    if (opts !== undefined && opts !== null) {
      if (typeof opts !== 'object')
        throw new TypeError('options must be given as an object')
      if (Object.getPrototypeOf(opts) !== Object.getPrototypeOf({}))
        throw new TypeError('options must be given as a plain object')
      if (opts.log) {
        if (typeof opts.log !== 'object')
          throw new TypeError('logger option value must be an object')
        for (let prop in dummyLog) {
          if (!(prop in opts.log))
            throw new TypeError(`logger must have a '${prop}' method`)
          if (typeof opts.log[prop] != 'function')
            throw new TypeError(`logger '${prop}' property is not a function`)
        }
      }
    }
    else opts = {}
  }
  catch (err) { return Promise.reject(err) }

  const tables = { semver: {}, tag: {}, url: {}, git: {} }
  const oldInfo = {}
  const log = opts.log || dummyLog

  const pkgDir = (where) ? path.resolve(where) : path.resolve()

  return lstatAsync(pkgDir).then(stats => {
    if (!stats.isDirectory()) {
      const errNotDir = new Error('Given path is not a directory')
      errNotDir.path = pkgDir
      errNotDir.code = 'ENOTDIR'
      throw errNotDir
    }

    const publicSelf = {
      path: pkgDir,
      audit: auditAll,
      add: add,
      contains: contains,
      getData: getData,
      serialize: serialize
    }
    Object.freeze(publicSelf)

    const mapFilepath = path.join(pkgDir, MAPFILE_NAME)
    return readFileAsync(mapFilepath, 'utf8').then(str => {
      let map
      // Strip BOM, if any
      if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1)
      try { map = JSON.parse(str) }
      catch (parseErr) {
        log.error('DownloadTracker', 'Failed to parse map file')
        throw parseErr
      }
      for (let p in map) {
        if (!DLT_TYPES.has(p)) continue
        if (!map[p] || typeof map[p] != 'object')
          log.warn(
            'DownloadTracker',
            `Violation of schema in map file; discarding '${p}' section`
          )
        else
          tables[p] = map[p]
      }
      if (map.created)
        oldInfo.created = map.created

      return publicSelf
    })
    .catch(err => {
      if (err.code !== 'ENOENT') {
        log.error('DownloadTracker', `Unusable map file, error code ${err.code}`)
        throw err
      }
      log.warn('DownloadTracker', 'Could not find a map file; trying to reconstruct...')
      return reconstructMap(pkgDir, log).then(map => {
        Object.assign(tables, map)
        return publicSelf
      })
    })
  })

  function isNonemptyObject(val) {
    const isObject = !!val && typeof val == 'object'
    return isObject && Object.keys(val).length > 0
  }

  function auditAll() {
    let pkgs
    let pkgKeys
    let pkgKeyIndex = 0
    let versions
    let versionKeys
    const errors = []

    function nextVersion(i) {
      if (i >= versionKeys.length) return Promise.resolve(null)

      const name = pkgKeys[pkgKeyIndex]
      const ver = versionKeys[i]
      let data = versions[ver]
      if (!data || typeof data != 'object') {
        log.warn(
          'DownloadTracker.audit',
          `Replacing violation of schema at ${name}@${ver}`
        )
        data = versions[ver] = {}
      }
      return auditOne('semver', data, pkgDir)
      .catch(err => {
        errors.push({
          data: preparedData('semver', name, ver),
          error: err
        })
      })
      .then(() => nextVersion(i+1))
    }

    function iterateSemverPkgs() {
      if (pkgKeyIndex >= pkgKeys.length) return Promise.resolve(null)

      const name = pkgKeys[pkgKeyIndex]
      versions = pkgs[name]
      if (!isNonemptyObject(versions)) {
        log.warn(
          'DownloadTracker.audit',
          `Removing violation of schema in semver section, name '${name}'`
        )
        delete pkgs[name]
        pkgKeys.splice(pkgKeyIndex, 1)
        return iterateSemverPkgs()
      }
      versionKeys = Object.keys(versions)
      return nextVersion(0).then(() => {
        ++pkgKeyIndex
        return iterateSemverPkgs()
      })
    }

    function iterateTagPkgs() {
      let err
      // pkgs is tables['tag'] here
      for (const n in pkgs) {
        const tags = pkgs[n]
        if (!isNonemptyObject(tags)) {
          log.warn(
            'DownloadTracker.audit',
            `Removing violation of schema in tag section, name '${n}'`
          )
          delete pkgs[n]
          continue
        }
        for (const tag in tags) {
          let data = tags[tag]
          if (!(data && typeof data == 'object')) {
            log.warn(
              'DownloadTracker.audit',
              `Replacing violation of schema at ${n}@${tag}`
            )
            data = tags[tag] = {}
          }
          if ('version' in data) {
            if (!tables.semver[n] || !tables.semver[n][data.version]) {
              err = new Error("Orphaned npm registry tag reference")
              err.code = 'EORPHANREF'
            }
          }
          else {
            err = new Error('Version missing from tag record')
            err.code = 'ENODATA'
          }
          if (err) {
            errors.push({
              data: preparedData('tag', n, tag),
              error: err
            })
          }
        }
      }
    }

    function nextCommit(i) {
      if (i >= versionKeys.length) return Promise.resolve(null)

      const repo = pkgKeys[pkgKeyIndex]
      const commit = versionKeys[i]
      let data = versions[commit]
      if (!data || typeof data != 'object') {
        log.warn(
          'DownloadTracker.audit',
          `Replacing violation of schema at ${repo}#${commit}`
        )
        data = versions[commit] = {}
      }
      let err
      let p
      if (!Object.keys(data).length) {
        err = new Error('No data in git record')
        err.code = 'ENODATA'
      }
      else if ('commit' in data) {
        // This is a ref record. Verify the reference:
        if (!versions[data.commit]) {
          err = new Error('Orphaned git commit reference')
          err.code = 'EORPHANREF'
        }
        else p = Promise.resolve()
      }
      return (err ? Promise.reject(err) : (p || auditOne('git', data, pkgDir)))
      .catch(err => {
        errors.push({
          data: preparedData('git', repo, commit),
          error: err
        })
      })
      .then(() => nextCommit(i+1))
    }

    function iterateGitPkgs() {
      if (pkgKeyIndex >= pkgKeys.length) return Promise.resolve(null)

      const repo = pkgKeys[pkgKeyIndex]
      versions = pkgs[repo]
      if (!isNonemptyObject(versions)) {
        log.warn(
          'DownloadTracker.audit',
          `Removing violation of schema in git section, repo '${repo}'`
        )
        delete pkgs[repo]
        pkgKeys.splice(pkgKeyIndex, 1)
        return iterateGitPkgs()
      }
      versionKeys = Object.keys(versions)
      return nextCommit(0).then(() => {
        ++pkgKeyIndex
        return iterateGitPkgs()
      })
    }

    function iterateUrlPkgs() {
      if (pkgKeyIndex >= pkgKeys.length) return Promise.resolve(null)

      const spec = pkgKeys[pkgKeyIndex]
      let data = pkgs[spec]
      if (!(data && typeof data == 'object')) {
        log.warn(
          'DownloadTracker.audit',
          `Replacing violation of schema at url ${spec}`
        )
        data = pkgs[spec] = {}
      }
      return auditOne('url', data, pkgDir)
      .catch(err => {
        errors.push({
          data: preparedData('url', null, spec),
          error: err
        })
      })
      .then(() => {
        ++pkgKeyIndex
        return iterateUrlPkgs()
      })
    }

    pkgs = tables.semver
    pkgKeys = Object.keys(pkgs)
    return iterateSemverPkgs()
    .then(() => {
      pkgs = tables.tag
      iterateTagPkgs()

      pkgs = tables.git
      pkgKeys = Object.keys(pkgs)
      pkgKeyIndex = 0
      return iterateGitPkgs()
    })
    .then(() => {
      pkgs = tables.url
      pkgKeys = Object.keys(pkgs)
      pkgKeyIndex = 0
      return iterateUrlPkgs()
    })
    .then(() => errors)
  }

  function add(type, data) {
    try {
      expectDLTType(type)
      if (data === undefined || data === null)
        throw new SyntaxError('package metadata required')
      expectPackageData(type, data)
    }
    catch (err) { return Promise.reject(err) }

    if (type === 'tag' && data.spec === 'latest')
      type = 'semver'

    // First, need to verify existence of item in download directory.
    return auditOne(type, data, pkgDir)
    .then(() => {
      const map = tables[type]
      const copy = {}
      for (let prop in data) {
        if (KEYFIELDS.has(prop)) continue
        copy[prop] = data[prop]
      }

      switch (type) {
        case 'semver':
          if (!map[data.name]) map[data.name] = {}
          map[data.name][data.version] = copy
          break
        case 'tag':
          // First make sure we cross-list in semver table
          const semverMap = tables.semver
          if (!semverMap[data.name])
            semverMap[data.name] = {}
          if (!semverMap[data.name][data.version])
            semverMap[data.name][data.version] = copy
          // Then refer to that from the tag table entry
          if (!map[data.name]) map[data.name] = {}
          map[data.name][data.spec] = { version: data.version }
          break
        case 'git':
          // NOTE: no longer any support for adding legacy-type git records
          if (!map[data.repo]) map[data.repo] = {}
          map[data.repo][data.commit] = copy
          if (data.refs) {
            for (let i = 0; i < data.refs.length; ++i) {
              map[data.repo][data.refs[i]] = { commit: data.commit }
            }
          }
          break
        case 'url':
          let spec = data.spec
          const u = url.parse(spec)
          if (u.protocol) spec = u.host + u.path
          map[spec] = copy
          break
        // no default currently necessary: it would never be visited
      }
      tables.dirty = true
    })
    .catch(err => {
      if (err.code == 'ENOENT') {
        const parentDir = path.parse(err.path).dir
        err = new Error(`Package ${data.filename} not found at ${parentDir}`)
      }
      throw err
    })
  }

  function contains(type, name, spec) {
    return getData(type, name, spec) ? true : false
  }

  // For type 'git', 'name' value can be the repo; if present,
  // then 'spec' is the commit or tag
  function getData(type, name, spec) {
    expectDLTType(type)
    switch (type) {
      case 'semver': case 'tag':
        expectNonemptyString(name, 'name')
        break
      case 'git':
        expectNonemptyString(name, 'git repo name')
        break
      case 'url':
        // I'm on the fence about this. It's not used, so why should it matter?
        if (name !== undefined && name !== null && name !== '')
          throw new SyntaxError('name value must be empty for type url')
        break
    }
    if (spec === undefined || spec === null)
      throw new SyntaxError('package spec required')
    if (typeof spec !== 'string')
      throw new TypeError('package spec must be given as a string')

    if (type === 'tag' && (spec === '' || spec === 'latest')) {
      type = 'semver'
      spec = ''
    }

    log.verbose('DownloadTracker.getData',
      [ 'type: ', type, ', name: ', name, ', spec: ', spec ].join('')
    )
    return preparedData(type, name, spec)
  }

  // This works whether spec is a semver range expression or a specific version
  function getMaxSemverMatch(spec, versions, opts) {
    const range = semver.validRange(spec, {loose: true})
    if (!range) {
      log.error('DownloadTracker preparedData', 'invalid semver spec:', spec)
      return null
    }

    let resultVer = null
    const vList = Object.keys(versions)

    if (opts && opts.filter) {
      const vMap = {}
      const vListClean = vList.map(function(v){ return semver.clean(v) })
        .filter(function(v, i){ if (v) vMap[v] = vList[i]; return !!v })
      const ver = semver.maxSatisfying(vListClean, range)
      if (ver) resultVer = vMap[ver]
    }
    else {
      resultVer = semver.maxSatisfying(vList, range)
    }

    return resultVer
  }

  function preparedData(type, name, spec) {
    let versions, ver
    let data, result
  
    switch (type) {
      case 'git':
        versions = tables.git[name]
        if (!versions) break
        if (spec && spec != '*') {
          ver = spec
          if (spec.indexOf('semver:') === 0)
            ver = getMaxSemverMatch(spec.slice(7), versions, {filter: true})
          if (ver) data = versions[ver]
        }
        // Given that the default branch of a git repo can be named arbitrarily,
        // I'm uncomfortable with this, because it amounts to a guess:
        else if (!(data = versions['master'] || versions['main'])) {
          // If there's only one full record for the given repo, use that.
          const fullRecords = []
          for (let id in versions)
            if (versions[id].filename) fullRecords.push(id)
          if (fullRecords.length === 1) {
            data = versions[fullRecords[0]]
            result = { repo: name, commit: fullRecords[0] }
          }
        }
        if (data && !result) {
          result = { repo: name }
          if (data.commit) { // fetched by tag or semver expr, maybe by '' or '*'
            result.commit = data.commit
            data = versions[data.commit]
            if (spec && spec != '*') result.spec = spec
          }
          else result.commit = spec
        }
        if (data) {
          Object.assign(result, data)
        }
        break
      case 'semver':
        versions = tables.semver[name]
        if (!versions) break
        ver = getMaxSemverMatch(spec, versions)
        if (ver) {
          data = versions[ver]
          result = { name: name, version: ver }
          Object.assign(result, data)
        }
        break
      case 'tag':
        versions = tables.tag[name]
        if (versions) data = versions[spec]
        if (data) {
          ver = data.version
          result = { name: name, spec: spec, version: ver }
          versions = tables.semver[name]
          if (versions) {
            data = versions[ver]
            Object.assign(result, data)
          }
        }
        break
      case 'url':
        let spec2 = spec
        const u = url.parse(spec2)
        if (u.protocol) spec2 = u.host + u.path
        data = tables.url[spec2]
        if (data) {
          result = { spec: spec }
          Object.assign(result, data)
        }
        break
    }
    if (result) result.type = type
    return result
  }

  function serialize() {
    // If tables are unchanged since init, abort.
    if (!tables.dirty) {
      log.verbose('DownloadTracker.serialize', 'Nothing new to write about')
      return Promise.resolve(false)
    }

    const map = {}
    // In each case, only want to use table if there's something in it
    for (const tblName of DLT_TYPES) {
      if (Object.keys(tables[tblName]).length)
        map[tblName] = tables[tblName]
    }

    const now = (new Date()).toLocaleString()
    if (oldInfo.created) {
      map.created = oldInfo.created
      map.updated = now
    }
    else map.created = now

    map.description = MAPFILE_DESC_FIELD
    map.version = 2

    const filepath = path.join(pkgDir, MAPFILE_NAME)
    log.verbose('DownloadTracker.serialize', 'writing to', filepath)
    return writeFileAsync(filepath, JSON.stringify(map))
    .then(() => {
      log.verbose('DownloadTracker.serialize', 'Map file written successfully.')
      delete tables.dirty
      return true
    })
    .catch(err => {
      log.warn('DownloadTracker.serialize', 'Failed to write map file')
      throw err
    })
  }
}
