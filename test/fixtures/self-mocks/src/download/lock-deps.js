const testConfig = {
  fromPackageLock: {},
  fromYarnLock: {},
  extract: {},
  readFromDir: {}
}

module.exports.setTestConfig = (fn, cfg) => {
  // cfg contains either data or error
  if (!(fn in testConfig))
    throw new Error('setTestConfig: unrecognized function "' + fn + '"')
  testConfig[fn] = { ...cfg }
}

const genericFunc = (fn) => {
  const cfg = testConfig[fn]
  if (cfg.error) throw cfg.error
  if (!cfg.data)
    throw new Error(`mock ${fn}: no data set for this function`)
  return cfg.data
}

module.exports.fromPackageLock = () => genericFunc('fromPackageLock')

module.exports.fromYarnLock = () => genericFunc('fromYarnLock')

module.exports.extract = () => {
  const cfg = testConfig.extract
  if (cfg.error) return Promise.reject(cfg.error)
  return Promise.resolve(cfg.data || [])
}

module.exports.readFromDir = () => {
  const cfg = testConfig.readFromDir
  if (cfg.error) return Promise.reject(cfg.error)
  return Promise.resolve(cfg.data || [])
}
