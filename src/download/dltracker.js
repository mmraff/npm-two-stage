/*
  Sourced from package npm-package-dl-tracker v1.1.1.
  The only change is the location from which npm-package-filename is require()d.
*/
// built-ins
const path = require('path')
const url = require('url')

// 3rd party dependencies
const fs = require('graceful-fs')
const semver = require('semver')
const npf = require('./npm-package-filename') // CHANGE

const reconstructMap = require('./reconstruct-map')

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

const GIT_REMOTES_LEGACY_DIR = '_git-remotes'
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

function auditOne(type, data, dir, cb)
{
  let fileSpec = data.filename
  if (!fileSpec) {
    if (type === 'git') {
      // In the legacy version of dltracker, it's not a tarball that gets saved,
      // but a cloned repo with an ad-hoc directory name (--> repoID).
      if (!data.repoID) {
        const err = new Error('No filename or repoID in data')
        err.code = 'ENODATA'
        return cb(err)
      }
      fileSpec = path.join(GIT_REMOTES_LEGACY_DIR, data.repoID)
      return fs.lstat(path.join(dir, fileSpec), function (err, stats) {
        if (err) return cb(err, data.repoID)
        if (!stats.isDirectory()) {
          err = new Error('Git repo path exists but is not a directory')
          err.code = 'ENOTDIR'
        }
        cb(err, data.repoID)
      })
    } // else,
    const err = new Error('No filename in data')
    err.code = 'ENODATA'
    return cb(err)
  }
  const filePath = path.resolve(dir, fileSpec)
  fs.lstat(filePath, function (err, stats) {
    if (err) return cb(err, fileSpec)
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
    cb(err, fileSpec)
  })
}

// Argument validation
function expectCallback(arg) {
  if (arg === undefined || arg === null)
    throw new SyntaxError('callback required')
  if (typeof arg !== 'function')
    throw new TypeError('argument must be a function')
}

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
        if (!(data.refs instanceof Array))
          throw new TypeError("git-type metadata property 'refs' must be an array")
        if (!data.refs.length)
          throw new SyntaxError("git-type metadata refs must contain at least one tag")
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
//   create(undefined||null||''||where, cb)
//   create(undefined||null||''||where, undefined||null||opts, cb)
function create(where, opts, cb)
{
  if (!cb) {
    cb = opts
    opts = null
  }
  if (where !== undefined && where !== null) {
    if (typeof where !== 'string')
      if (Object.getPrototypeOf(where) !== Object.getPrototypeOf(new String()))
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
          throw new Error(`logger must have a '${prop}' method`)
        if (typeof opts.log[prop] != 'function')
          throw new TypeError(`logger '${prop}' property is not a function`)
      }
    }
  }
  else opts = {}
  expectCallback(cb)

  const tables = { semver: {}, tag: {}, url: {}, git: {} }
  const oldInfo = {}
  const log = opts.log || dummyLog

  // where.toString() covers the (unlikely) case of (where instanceof String)
  const pkgDir = (where) ? path.resolve(where.toString()) : path.resolve()

  fs.stat(pkgDir, function (err, stats) {
    if (err) return cb(err)
    if (!stats.isDirectory()) {
      return cb(new Error('Given path is not a directory: ' + where))
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
    fs.readFile(mapFilepath, 'utf8', function (fsErr, str) {
      if (fsErr) {
        if (fsErr.code !== 'ENOENT') {
          log.error('DownloadTracker', `Unusable map file, error code ${fsErr.code}`)
          return cb(fsErr)
        }
        log.warn('DownloadTracker', 'Could not find a map file; trying to reconstruct...')
        return reconstructMap(pkgDir, log, function(err, map) {
          if (err) return cb(err)
          Object.assign(tables, map)
          cb(null, publicSelf)
        })
      }

      let map
      // Strip BOM, if any
      if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1)
      try { map = JSON.parse(str) }
      catch (parseErr) {
        log.error('DownloadTracker', 'Failed to parse map file')
        return cb(parseErr)
      }
      for (let p in map) {
        if (DLT_TYPES.has(p)) tables[p] = map[p]
      }
      if (map.created)
        oldInfo.created = map.created

      cb(null, publicSelf)
    })
  })

  function auditAll(cb) {
    expectCallback(cb)

    let pkgs
    let pkgKeys
    let pkgKeyIndex = 0
    let versions
    let versionKeys
    const errors = []

    function nextVersion(i, done) {
      if (i >= versionKeys.length) return done()

      const name = pkgKeys[pkgKeyIndex]
      const ver = versionKeys[i]
      const data = versions[ver]
      auditOne(
        'semver', data, pkgDir,
        function(err) {
          if (err) errors.push({
            data: preparedData('semver', name, ver),
            error: err
          })
          nextVersion(++i, done)
        }
      )
    }

    function nextSemverPkg(done) {
      if (pkgKeyIndex >= pkgKeys.length) return done()

      versions = pkgs[pkgKeys[pkgKeyIndex]]
      versionKeys = Object.keys(versions)
      nextVersion(0, function() {
        ++pkgKeyIndex
        nextSemverPkg(done)
      })
    }

    function iterateTagPkgs() {
      let err
      // pkgs is tables['tag'] here
      for (let n in pkgs) {
        const tags = pkgs[n]
        for (let tag in tags) {
          const data = tags[tag]
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

    function nextCommit(i, done) {
      if (i >= versionKeys.length) return done()

      let err
      const repo = pkgKeys[pkgKeyIndex]
      const commit = versionKeys[i]
      const data = versions[commit]
      if ('commit' in data) {
        // This is a ref record. Verify the reference:
        if (!versions[data.commit]) {
          err = new Error("Orphaned git commit reference")
          err.code = 'EORPHANREF'
          errors.push({
            data: preparedData('git', repo, commit),
            error: err
          })
        }
        return nextCommit(++i, done)
      }
      if (!Object.keys(data).length) {
        err = new Error('No data in git record')
        err.code = 'ENODATA'
        errors.push({
          data: preparedData('git', repo, commit),
          error: err
        })
        return nextCommit(++i, done)
      }
      auditOne(
        'git', data, pkgDir,
        function(err) {
          if (err) errors.push({
            data: preparedData('git', repo, commit),
            error: err
          })
          nextCommit(++i, done)
        }
      )
    }

    function nextGitPkg(done) {
      if (pkgKeyIndex >= pkgKeys.length) return done()

      versions = pkgs[pkgKeys[pkgKeyIndex]]
      versionKeys = Object.keys(versions)
      nextCommit(0, function() {
        ++pkgKeyIndex
        nextGitPkg(done)
      })
    }

    function nextURLPkg(done) {
      if (pkgKeyIndex >= pkgKeys.length) return done()

      const spec = pkgKeys[pkgKeyIndex]
      const data = pkgs[spec] 
      auditOne(
        'url', data, pkgDir,
        function(err) {
          if (err) errors.push({
            data: preparedData('url', null, spec),
            error: err
          })
          ++pkgKeyIndex
          nextURLPkg(done)
        }
      )
    }

    pkgs = tables['semver']
    pkgKeys = Object.keys(pkgs)
    nextSemverPkg(function() {
      pkgs = tables['tag']
      iterateTagPkgs()
      pkgs = tables['git']
      pkgKeys = Object.keys(pkgs)
      pkgKeyIndex = 0
      nextGitPkg(function() {
        pkgs = tables['url']
        pkgKeys = Object.keys(pkgs)
        pkgKeyIndex = 0
        nextURLPkg(function() {
          cb(null, errors)
        })
      })
    })
  }

  function add(type, data, cb)
  {
    expectDLTType(type)
    if (data === undefined || data === null)
      throw new SyntaxError('package metadata required')
    expectCallback(cb)
    expectPackageData(type, data)

    if (type === 'tag' && (data.spec === '' || data.spec === 'latest'))
      type = 'semver'

    // First, need to verify existence of item in download directory.
    auditOne(type, data, pkgDir, function(err) {
      if (err) {
        if (err.code == 'ENOENT') {
          const parentDir = path.parse(err.path).dir
          err = new Error(`Package ${data.filename} not found at ${parentDir}`)
        }
        return cb(err)
      }

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

      cb()
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
        // Allowable: empty name arg to retrieve legacy git data by spec alone;
        // else it must be the name of the repo
        if (name !== undefined && name !== null && typeof name !== 'string')
          throw new TypeError('git repo name must be given as a string')
        break
      case 'url':
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
        if (!name) {
          data = tables.git[spec]
          // legacy version data; only guaranteed field is repoID
          if (data) result = { spec: spec }
        }
        else {
          versions = tables.git[name]
          if (!versions) break
          if (spec && spec != '*') {
            ver = spec
            if (spec.indexOf('semver:') === 0)
              ver = getMaxSemverMatch(spec.slice(7), versions, {filter: true})
            if (ver) data = versions[ver]
          }
          // Given that the default branch of a git repo *can* be named
          // arbitrarily, I'm uncomfortable with this:
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

  function serialize(cb)
  {
    expectCallback(cb)

    // If tables are unchanged since init, abort.
    if (!tables.dirty) {
      log.verbose('DownloadTracker.serialize', 'Nothing new to write about')
      return cb(false)
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
    fs.writeFile(filepath, JSON.stringify(map), function(er) {
      if (er)
        log.warn('DownloadTracker.serialize', 'Failed to write map file')
      else
        log.verbose('DownloadTracker.serialize', 'Map file written successfully.')
      delete tables.dirty
      cb(er)
    })
  }
}

