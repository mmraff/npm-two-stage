const npa = require('npm-package-arg')
const mockData = require('./mock-dl-data.js')

module.exports = gitOffline

function gitOffline(spec, dlData, opts, next) {
  const tarballPath = mockData.getFilename(spec)
  if (!tarballPath)
    next(new Error(`Test is misconfigured, don't know about ${spec.raw}`))
  else next(null, npa(tarballPath))
}
