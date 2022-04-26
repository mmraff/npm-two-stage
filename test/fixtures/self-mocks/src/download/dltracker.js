const npa = require('npm-package-arg')
const mockData = require('../mock-dl-data')
const npm = require('../npm')
const npf = require('./npm-package-filename')

const typeMap = module.exports.typeMap = {
  version: 'semver',
  range: 'semver',
  tag: 'tag',
  remote: 'url',
  git: 'git'
}

const store = { semver: {}, tag: {}, git: {}, url: {} }

function simulateTrackerAdd(spec) {
  const npaData = npa(spec)
  const filename = mockData.getFilename(npaData)
  const npfData = npf.parse(filename)
  let data
  switch (npfData.type) {
    case 'tag':
      if (!(data = store.tag[npaData.name]))
        data = store.tag[npaData.name] = {}
      if (!data[npaData.fetchSpec])
        data[npaData.fetchSpec] = { version: npfData.versionComparable }
      // no break, deliberate pass-through
    case 'semver':
      if (!(data = store.semver[npaData.name]))
        data = store.semver[npaData.name] = {}
      if (!data[npfData.versionComparable]) // actually we should assert this
        data[npfData.versionComparable] = { filename }
      break
    case 'git':
      if (!(data = store.git[npfData.repo]))
        data = store.git[npfData.repo] = {}
      if (!data[npfData.commit]) // actually we should assert this
        data[npfData.commit] = { filename }
      break
    case 'url':
      store.url[npfData.url] = { filename }
      break
  }
}

// Put data for all the mockData items into our store
for (let npaType in typeMap) {
  const first = {}
  let idx = 0
  do {
    const spec = mockData.getSpec(npaType, idx)
    if (spec == first[npaType]) break
    if (idx == 0) first[npaType] = spec
    if (idx == 2 && npaType == 'git') { // the special one (legacy)
      store.git[spec] = { repoID: mockData.getFilename(npa(spec)) }
    }
    else simulateTrackerAdd(spec)
    ++idx
  } while (true)
}

npm.dlTracker = {
  path: 'fake/test/path',
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
  }
}
