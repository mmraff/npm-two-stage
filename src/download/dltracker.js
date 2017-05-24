// Module purposes:
// * to help the package downloader avoid redundant downloads,
//   by keeping track of what's in the local directory designated
//   to hold package tarballs
// * to provide information to the offliner module for identifying
//   downloaded packages where the spec is not recognized by semver
//   (e.g. URL, tag, ...)

module.exports = DownloadTracker

var path = require('path')
  , fs = require('graceful-fs')
  , assert = require('assert')
  , semver = require('semver')
  , url = require('url')
  , log = require('npmlog')
  , gitAux = require('./git-aux.js')
  , pkgFilenameParser = require('./npm-package-filename.js')
  , NOT_INIT_MSG = 'Uninitialized! (initialize() must be the first operation)'

var DLT_TYPES = {
  'git': true,
  'semver': true,
  'tag': true,
  'url': true
}

function DownloadTracker(dbg)
{
  var tables = { semver: {}, tag: {}, url: {}, git: {} }

  if (dbg) {
    this.dump = function () { console.log(JSON.stringify(tables)) }
  }

  this.initialize = function (where, phantom, cb) {
    init.call(this, tables, where, phantom, cb)
  }
  this.add = function (type, data, cb) {
    add.call(this, tables, type, data, cb)
  }
  this.contains = function (type, pkgname, pkgSpec) {
    return contains.call(this, tables, type, pkgname, pkgSpec)
  }
  this.getData = function (type, pkgname, pkgSpec) {
    return getData.call(this, tables, type, pkgname, pkgSpec)
  }
  this.serialize = function (cb) {
    serialize.call(this, tables, cb)
  }
}

// Helper for initialization
function iterateAndAdd(itemList, tables)
{
  var parsed = null
    , name, version, data
  for (var i in itemList) {
    parsed = pkgFilenameParser.parse(itemList[i])
    if (this.dump && !parsed)
      log.warn('DownloadTracker.initialize', 'Failed on', itemList[i])
    if (!parsed) continue
    name = parsed.packageName
    version = parsed.versionComparable
    data = { filename: itemList[i] }
    if (!tables.semver[name]) tables.semver[name] = {}
    tables.semver[name][version] = data
  }
  if (this.dump) console.log(itemList.length, 'items read')
}

function init(tables, where, phantoms, cb)
{
  var pkgDir = (where) ? path.resolve(where) : path.resolve()
    , self = this

  fs.stat(pkgDir, function (err, stats) {
    if (err) return cb(err)
    if (! stats.isDirectory()) {
      return cb(
        new Error('Cannot use as package path, not a directory: ' + where)
      )
    }
    // TODO: Check write permission on the given path (else get an access error)

    // So that the user can refer to dlDir.path:
    Object.defineProperty(self, 'path', {
      value: pkgDir
    })

    var mapFilepath = path.join(pkgDir, 'dltracker.json')
    fs.readFile(mapFilepath, 'utf8', function (fsErr, data) {
      if (fsErr) {
        if (fsErr.code !== 'ENOENT') {
          log.error('DownloadTracker.initialize', 'Could not read map file')
          return cb(fsErr)
        }
        return tryReconstruct()
      }

      var map
      try { map = JSON.parse(data) }
      catch (parseErr) {
        log.error('DownloadTracker.initialize', 'Failed to parse map file')
        return cb(parseErr)
      }
      for (var p in map)
        if (p in DLT_TYPES) tables[p] = map[p]
      // To be totally thorough, could verify that each filename in the
      // maps exists in pkgDir; but it would be as meaningless as checking
      // for the existence of phantom files, unless we know that this
      // instance is being managed by npm install --offline
      if (phantoms) return loadPhantoms()
      cb()
    })

    // TODO: consider adding to this to handle git repos orphaned by loss of map.
    // It would require parsing the mangled directory names, or maybe
    // digging into the contents of each repo...
    function tryReconstruct()
    {
      // Recognize anything that looks like a package file in the
      // given directory, and table it
      fs.readdir(pkgDir, function(err, files) {
        if (err) return done(err)

        iterateAndAdd(files, tables)

        if (phantoms) return loadPhantoms()
        cb()
      })
    }

    // phantoms is a file that contains a list of filenames, such as might
    // be produced by "ls > ../path/to/list.txt"
    function loadPhantoms()
    {
      fs.readFile(phantoms, function(err, data) {
        // User will want to know if phantoms file named doesn't exist
        if (err) return cb(err)

        // Table anything on the list that looks like a package file
        var lines = data.toString('utf8').trim().split(/\s+/)
        iterateAndAdd(lines, tables)
        cb()
      })
    }
  })
}

function add(tables, type, data, cb)
{
  assert(this.path, NOT_INIT_MSG)
  assert(type && typeof type === 'string', 'package type required')
  assert(type in DLT_TYPES, 'invalid type "' + type + '"')
  assert(data && typeof data === 'object', 'package metadata required')
  assert(typeof cb === 'function', 'callback required')

  // First, need to verify existence of item in download directory.
  // If it's a git repo, we need gitAux to tell us the name of the subdirectory
  // where all the git repos get put.
  var fileSpec = data.filename // no such property if type is git
  if (type === 'git')
    fileSpec = path.join(gitAux.remotesDirName(), data.repoID)
  fs.exists(path.join(this.path, fileSpec), function(found) {
    if (!found)
      return cb(new Error('Package not found at download path: ' + fileSpec))

    var map = tables[type]
    var copy = {}
    for (var prop in data) {
      if (prop === 'name' || prop === 'version' || prop === 'spec') continue
      copy[prop] = data[prop]
    }

    switch (type) {
      case 'semver':
        if (!map[data.name]) map[data.name] = {}
        map[data.name][data.version] = copy
        break
      case 'tag':
        if (!map[data.name]) map[data.name] = {}
        map[data.name][data.spec] = copy
        break
      case 'git':
      case 'url':
        map[data.spec] = copy
        break
      // no default currently necessary: it would never be visited
    }
    tables.dirty = true

    if (data.version && (type !== 'semver')) { // bonus listing for semver map
      map = tables.semver
      copy = { filename: data.filename }
      if (!map[data.name]) map[data.name] = {}
      map[data.name][data.version] = copy
    }

    cb()
  })
}

function contains(tables, type, name, spec)
{
  return getData.call(this, tables, type, name, spec) ? true : false
}

function getData(tables, type, name, spec)
{
  assert(this.path, NOT_INIT_MSG)
  assert(type && typeof type === 'string', 'package type required')
  assert(type in DLT_TYPES, 'invalid type "' + type + '"')
  if (type === 'semver' || type === 'tag')
    assert(typeof name === 'string' && 0 < name.length,
           'package name required for type == ' + type)
  assert(typeof spec === 'string' && 0 < spec.length, 'package spec required')

  var versions, ver
  var data, result, prop

  log.verbose('DownloadTracker.getData', 'type:', type, ', name:', name, ', spec:', spec)
  switch (type) {
    case 'git':
      data = tables.git[spec]
      if (data) {
        // BTW, 'spec' arg is same as 'from' property in this case
        result = {}
        for (prop in data) result[prop] = data[prop]
      }
      break
    case 'semver':
      versions = tables.semver[name]
      if (!versions) break
      var range = semver.validRange(spec, true)
      if (semver.valid(spec, true)) {
        for (ver in versions) {
          if (semver.eq(ver, spec)) {
            data = versions[ver]
            break
          }
        }
      }
      else if (range !== null) {
        var vList = Object.keys(versions)
        ver = semver.maxSatisfying(vList, range)
        if (ver) data = versions[ver]
      }
      else log.error('DownloadTracker.getData', 'invalid semver spec:', spec)
      if (data) {
        result = { name: name, version: ver }
        for (prop in data) result[prop] = data[prop]
      }
      break
    case 'tag':
      versions = tables.tag[name]
      if (versions) data = versions[spec]
      if (data) {
        // 'name' and 'spec' only for debug - 'filename' is what's important
        result = { name: name, spec: spec }
        for (prop in data) result[prop] = data[prop]
      }
      break
    case 'url':
      data = tables.url[spec]
      if (data) {
        // 'spec' property only for debug - probably always the same as 'from'
        result = { spec: spec }
        for (prop in data) result[prop] = data[prop]
      }
      break
  }
  return result
}

function serialize(tables, cb)
{
  assert(this.path, NOT_INIT_MSG)
  assert(cb && typeof cb === 'function', 'callback is required')

  // If tables are unchanged since init, abort.
  if (!tables.dirty) {
    log.verbose('DownloadTracker.serialize', 'Nothing new to write about')
    return cb(false)
  }

  var map = {}
  // In each case, only want to use table if there's something in it
  for (var tblName in DLT_TYPES) {
    if (!tables[tblName]) {
      if (this.dump) log.error('serialize', tblName, 'not found in tables!')
      continue
    }
    if (Object.keys(tables[tblName]).length)
      map[tblName] = tables[tblName]
  }

  map.description = [
    'This file was written as a result of the command **npm download**.  ',
    'It enables **npm install --offline** to map packages to their ',
    'corresponding downloaded files when they are specified by something ',
    'other than a semver-2.0-compliant version expression.  ',
    'DO NOT DELETE this file, and ensure that it travels with the files ',
    'that were downloaded in the same session, until you have followed up ',
    'with the command **npm install --offline** and are satisfied with the ',
    'installation.'
  ].join('')
  map.timestamp = (new Date()).toLocaleString()

  var filepath = path.join(this.path, 'dltracker.json')
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

