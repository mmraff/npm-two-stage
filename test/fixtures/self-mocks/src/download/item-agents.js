const npa = require('npm-package-arg')

const testConfig = {
  getOperations: {},
  processDependencies: {}
}

const lastOpts = {}
const purgeOpts = () => { for (const prop in lastOpts) delete lastOpts[prop] }

module.exports.getLastOpts = () => ({ ...lastOpts })

module.exports.getOperations = (depList, opts) => {
  purgeOpts()
  Object.assign(lastOpts, opts)
  const results = []
  for (const item of depList) {
    const spec = typeof item === 'string' ?
      item : (item.name + '@' + item.version)
    if (spec in testConfig.getOperations) {
      const testData = testConfig.getOperations[spec]
      if (testData) results.push(Promise.resolve(testData))
    }
    else
      results.push(Promise.reject(
        new Error(`mock getOperations: ${spec} not known`)
      ))
  }
  return results
}

module.exports.processDependencies = (manifest, opts) => {
  purgeOpts()
  Object.assign(lastOpts, opts)
  const spec = manifest.name + '@' + manifest.version
  const testData = testConfig.processDependencies[spec]
  if (!testData) return Promise.reject(
    new Error(`mock itemAgents.processDependencies does not recognize spec '${spec}'`)
  )
  return Promise.resolve(testData)
}

module.exports.xformResult = (res) => {
  // Verbatim from the source
  return res.reduce((acc, val) => acc.concat(val), [])
}

module.exports.setTestConfig = (fn, data) => {
  const section = testConfig[fn]
  for (const spec in section) delete section[spec]
  if (data) for (const spec in data) section[spec] = data[spec]
}

