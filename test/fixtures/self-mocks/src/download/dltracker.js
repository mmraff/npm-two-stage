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

npm.dlTracker = {
  path: 'fake/test/path',
  // NOT in actual dltracker:
  purge: () => {
    store.semver = {};
    store.tag = {};
    store.git = {};
    store.url = {};
  },
  // NOT in actual dltracker:
  addLegacyGit: function(spec, repoID) {
    store.git[spec] = { repoID }
  },
  add: function(type, data, cb) {
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
        const parsed = url.parse(spec)
        data = store.url[parsed.host + parsed.path]
        break
    }
    return data
  },
  serialize(cb) {
    if (!hasChanges) cb(false)
    else {
      hasChanges = false
      cb()
    }
  }
}
