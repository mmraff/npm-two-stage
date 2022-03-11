const promisify = require('util').promisify
const readdirAsync = promisify(require('graceful-fs').readdir)
const npf = require('./npm-package-filename') // CHANGED from '@offliner/npm-package-filename'

module.exports = reconstructMap

// Helper for initialization: used on a list of items for which
// there is no mapping in the dltracker.json file.
// (We're keeping this factored out of reconstructMap in case we introduce
// another use for it, e.g., "phantoms")
function iterateAndAdd(itemList, map, log) {
  let name, version, table
  for (let i = 0; i < itemList.length; ++i) {
    const filename = itemList[i]
    const parsed = npf.parse(filename)
    if (!parsed) { // non-compliant entry
      log.warn('DownloadTracker', `failed to parse filename '${filename}'`)
      continue
    }
    switch (parsed.type) {
      case 'semver':
        name = parsed.packageName
        version = parsed.versionComparable
        if (!map.semver) map.semver = {}
        if (!map.semver[name]) map.semver[name] = {}
        table = map.semver[name]
        break
      case 'git':
        name = parsed.repo
        version = parsed.commit
        if (!map.git) map.git = {}
        if (!map.git[name]) map.git[name] = {}
        table = map.git[name]
        break
      case 'url':
        if (!map.url) map.url = {}
        table = map.url
        version = parsed.url
        break
      default:
        log.warn('DownloadTracker', `unrecognized parsed type '${parsed.type}'`)
        continue
    }
    table[version] = { filename: filename }
  }
}

const dummyFunc = () => {}
const dummyLog = {
  error: dummyFunc, warn: dummyFunc, info: dummyFunc, verbose: dummyFunc
}

function reconstructMap(dir, log) {
  try {
    if (dir === undefined || dir === null || dir === '')
      throw new SyntaxError("No path given")
    if (typeof dir != 'string')
      throw new TypeError("First argument must be a non-empty string")
    if (log) {
      if (typeof log !== 'object')
        throw new TypeError('logger must be an object')
      for (let prop in dummyLog) {
        if (!(prop in log))
          throw new TypeError(`logger must have a '${prop}' method`)
        if (typeof log[prop] != 'function')
          throw new TypeError(`logger '${prop}' property is not a function`)
      }
    }
    else log = dummyLog
  }
  catch(err) { return Promise.reject(err) }

  // Recognize anything that looks like a package file in the
  // given directory, and table it
  return readdirAsync(dir).then(files => {
    const map = {}
    iterateAndAdd(files, map, log)
    return map
  })
}
