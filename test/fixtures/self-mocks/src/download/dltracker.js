const path = require('path')

const typeMap = module.exports.typeMap = {
  version: 'semver',
  range: 'semver',
  tag: 'tag',
  remote: 'url',
  git: 'git'
}

function mockAdd(my, type, dlData) {
  /*
    Note that this is sloppy, compared to what's done in real dltracker.js:
    we leave the key props in the data, even though that results in lots
    of redundancy. But then here we don't have to do the extra work of
    putting those properties into what we return from mock getData()
    (except special handling in tag and git tag cases).
  */
  const data = Object.assign({}, dlData)
  let group
  switch (type) {
    case 'url':
      // Not exactly the same treatment as the real thing
      my.store.url[data.spec] = data
      break
    case 'git':
      if (!(group = my.store.git[data.repo]))
        group = my.store.git[data.repo] = {}
      group[data.commit] = data
      if (data.refs)
        for (let i = 0; i < data.refs.length; ++i)
          group[data.refs[i]] = { commit: data.commit }
      break
    case 'tag':
      if (!(group = my.store.tag[data.name]))
        group = my.store.tag[data.name] = {}
      group[data.spec] = { version: data.version }
      // no break, deliberate pass-through
    case 'semver':
      if (!(group = my.store.semver[data.name]))
        group = my.store.semver[data.name] = {}
      if (!group[data.version]) {
        delete data.spec // in case it fell through from 'tag' case
        group[data.version] = data
      }
      break
    default:
      return Promise.reject(new TypeError(`Unhandled type '${type}'`))
  }
  my.hasChanges = true
  return Promise.resolve()
}

function mockGetData(my, type, name, spec) {
  const typeSection = my.store[type]
  if (!typeSection)
    throw new RangeError(`given package type "${type}" unrecognized`)
  let group, result
  switch (type) {
    case 'url':
      result = Object.assign({}, typeSection[spec])
      result.spec = spec
      break
    case 'tag':
      let version
      if ((group = typeSection[name]) && (version = group[spec].version)) {
        result = Object.assign({}, my.store.semver[name][version])
        result.spec = spec
      }
      break
    case 'semver':
      if ((group = typeSection[name]) && group[spec])
        result = Object.assign({}, group[spec])
      else if (group && spec == '*') // serves build-ideal-tree case: tag=='latest'
        // Take the first available
        for (const v in group) {
          result = Object.assign({}, group[v])
          break
        }
      break
    case 'git':
      if ((group = typeSection[name]) && group[spec]) {
        result = Object.assign({}, group[spec])
        if (!result.repo)
          result = Object.assign({ spec }, typeSection[name][result.commit])
        if (result.refs) result.refs = Object.assign([], result.refs)
      }
      break
  }
  return result
}

function mockContains(my, type, name, spec) {
  const typeSection = my.store[type]
  if (!typeSection)
    throw new RangeError(`given package type "${type}" unrecognized`)
  if (type == 'url') return typeSection[spec] ? true : false
  return (typeSection[name] && typeSection[name][spec]) ? true : false
}

function mockSerialize(my) {
  const hadChanges = my.hasChanges
  my.hasChanges = false
  return Promise.resolve(hadChanges)
}

function newDlTracker(dir) {
  const kernel = {
    path: path.resolve(dir || 'test/fake/path'),
    store: { semver: {}, tag: {}, git: {}, url: {} },
    hasChanges: false
  }
  return {
    path: kernel.path,
    add: (type, data) => mockAdd(kernel, type, data),
    getData: (type, name, spec) => mockGetData(kernel, type, name, spec),
    contains: (type, name, spec) => mockContains(kernel, type, name, spec),
    serialize: () => mockSerialize(kernel)
  }
}

module.exports.create = function(dir, opts) {
  return Promise.resolve(newDlTracker(dir))
}
module.exports.createSync = function(dir, opts) {
  return newDlTracker(dir)
}

