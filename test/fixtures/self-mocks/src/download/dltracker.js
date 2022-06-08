const path = require('path')

const npm = require('../npm')

const typeMap = module.exports.typeMap = {
  version: 'semver',
  range: 'semver',
  tag: 'tag',
  remote: 'url',
  git: 'git'
}

const store = { semver: {}, tag: {}, git: {}, url: {} }
let hasChanges = false
let _serializeWasCalled = false

npm.dlTracker = {
  path: 'fake/test/path',
  // NOT in actual dltracker:
  purge: () => {
    store.semver = {}
    store.tag = {}
    store.git = {}
    store.url = {}
    _serializeWasCalled = false
    hasChanges = false
  },
  // NOT in actual dltracker:
  addLegacyGit: function(spec, repoID) {
    store.git[spec] = { repoID }
  },
  add: function(type, data, cb) {
    if (errorCfg.add.countDown) --errorCfg.add.countDown
    if (errorCfg.add.throwIt && !errorCfg.add.countDown) {
      const err = new Error('add() error from mock dltracker')
      if (errorCfg.add.code) err.code = errorCfg.add.code
      return cb(err)
    }
    let group
    switch (type) {
      case 'tag':
        if (!(group = store.tag[data.name]))
          group = store.tag[data.name] = {}
        group[data.spec] = { version: data.version }
        // no break, deliberate pass-through
      case 'semver':
        if (!(group = store.semver[data.name]))
          group = store.semver[data.name] = {}
        group[data.version] = { filename: data.filename }
        break
      case 'git':
        if (!(group = store.git[data.repo]))
          group = store.git[data.repo] = {}
        group[data.commit] = { filename: data.filename }
        break
      case 'url':
        // Not exactly the same treatment as the real thing
        store.url[data.spec] = { filename: data.filename }
        break
      default:
        return cb(new Error(`Unhandled type '${type}'`))
    }
    hasChanges = true
    cb()
  },
  getData: function(type, name, spec) {
    let newSpec = spec
    let data
    switch (type) {
      case 'tag':
        if (!(data = store.tag[name])) break
        if (!(data = data[spec])) break
        newSpec = data.version
      case 'semver':
        // TODO? this does not have the logic to pick a record by range spec
        if (!(data = store.semver[name])) break
        data = data[newSpec]
        break
      case 'git':
        if (!(data = store.git[name]))
          data = store.git[spec]
        else data = data[spec]
        break
      case 'url':
        data = store.url[spec]
        break
    }
    return data
  },
  contains: function(type, name, spec) {
    return this.getData(type, name, spec) ? true : false
  },
  serialize(cb) {
    _serializeWasCalled = true
    if (!hasChanges) cb(false)
    else {
      hasChanges = false
      cb()
    }
  },
  serializeWasCalled() {
    return _serializeWasCalled
  }
}

const errorCfg = {
  create: { throwIt: false },
  add: { throwIt: false }
}

module.exports.setErrorState = (fnName, state, errCode, countDown) => {
  errorCfg[fnName].throwIt = state
  errorCfg[fnName].code = errCode
  errorCfg[fnName].countDown = countDown
}
npm.dlTracker.setErrorState = module.exports.setErrorState

module.exports.create = function(dir, opts, cb) {
  if (errorCfg.create.throwIt) {
    const err = new Error('create() error from mock dltracker')
    if (errorCfg.create.code) err.code = errorCfg.create.code
    return cb(err)
  }
  npm.dlTracker.path = dir ? path.resolve(dir) : path.resolve()
  cb(null, npm.dlTracker)
}
