const npa = require('npm-package-arg')

const testConfig = {
  handleItem: {},
  processDependencies: {}
}

const lastOpts = {}
const purgeOpts = () => { for (const prop in lastOpts) delete lastOpts[prop] }

module.exports.getLastOpts = () => ({ ...lastOpts })

module.exports.handleItem = (spec, opts) => {
//console.log(`$$$ mock itemAgents.handleItem: for spec ${spec}, given opts`, opts)
  purgeOpts()
  Object.assign(lastOpts, opts)
  const testData = testConfig.handleItem[spec]
  if (!testData) return Promise.reject(
    new Error(`mock itemAgents.handleItem does not recognize spec '${spec}'`)
  )
  return Promise.resolve(testData)
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
  // TODO: need to put more thought into this:
  // Should it really be cumulative, when the corresponding function in
  // mockPacote wipes out any previous records?
  // Cumulative encourages us to rely on the leftovers of a previous test,
  // which is unwise and not good form.
  const section = testConfig[fn]
  for (const spec in data) {
    section[spec] = data[spec]
  }
}

