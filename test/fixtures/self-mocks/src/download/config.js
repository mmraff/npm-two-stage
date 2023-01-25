const mockData = {
  semver: {}, tag: {}, git: {}, url: {}
}

let hasChanges = false

const dlTracker = {
  path: 'dummy/tracker/path',
  purge: () => { // not a method of the real thing!
    mockData.semver = {}
    mockData.tag = {}
    mockData.git = {}
    mockData.url = {}
    hasChanges = false
  },
  contains: (type, name, spec) => {
    const typeSection = mockData[type]
    if (!typeSection)
      throw new RangeError(`given package type "${type}" unrecognized`)
    if (type == 'url') return typeSection[spec] ? true : false
    return (typeSection[name] && typeSection[name][spec]) ? true : false
  },
  add: (type, dlData) => {
    const data = Object.assign({}, dlData)
    /*
      Note that this is sloppy, compared to what's done in real dltracker.js:
      we leave the key props in the data, even though that results in lots
      of redundancy. But then here we don't have to do the extra work of
      putting those properties into what we return from mock getData()
      (except special handling in tag and git tag cases).
    */
    switch (type) {
      case 'url':
        mockData.url[data.spec] = data
        break
      case 'git':
        if (!mockData.git[data.repo]) mockData.git[data.repo] = {}
        mockData.git[data.repo][data.commit] = data
        if (data.refs)
          for (let i = 0; i < data.refs.length; ++i)
            mockData.git[data.repo][data.refs[i]] = { commit: data.commit }
        break
      case 'tag':
        if (!mockData.tag[data.name]) mockData.tag[data.name] = {}
        mockData.tag[data.name][data.spec] = { version: data.version }
      case 'semver':
        if (!mockData.semver[data.name]) mockData.semver[data.name] = {}
        if (!mockData.semver[data.name][data.version]) {
          delete data.spec // in case it fell through from 'tag' case
          mockData.semver[data.name][data.version] = data
        }
        break
      default: return Promise.reject(new TypeError(`Unhandled type '${type}'`))
    }
    hasChanges = true
    return Promise.resolve()
  },
  getData: (type, name, spec) => {
    /*
      The finer details of actual dltracker.js getData are skipped here,
      because we don't need to use any arcane specs except when testing the
      actual dltracker.js.
    */
    const typeSection = mockData[type]
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
          result = Object.assign({}, mockData.semver[name][version])
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
  },
  serialize: () => {
    const hadChanges = hasChanges
    hasChanges = false
    return Promise.resolve(hadChanges)
  }
}

const cmdOpts = {}
let cache
let log
let frozen = false

module.exports = {
  get: (prop) => {
    switch (prop) {
      case 'dlTracker': return dlTracker
      case 'cache': return cache || null
      case 'log': return log || null
      case 'opts': return cmdOpts
    }
  },
  set: (prop, data) => {
    switch (prop) {
      case 'cache': cache = data; break
      case 'log': log = data; break
      case 'opts':
        if (typeof data != 'object')
          throw new Error('mock config: Attempt to set opts with a non-object!')
        Object.assign(cmdOpts, data)
        break
    }
  },
  isFrozen: () => frozen,
  freeze: () => {
    if (frozen)
      throw new Error('Attempt to freeze mock config when it is already frozen')
    frozen = true
  },
  unfreeze: () => {
    frozen = false
  },
  reset: () => {
    dlTracker.path = 'dummy/tracker/path'
    cache = null
    log = null
    for (const prop in cmdOpts) delete cmdOpts[prop]
    frozen = false
  }
}
