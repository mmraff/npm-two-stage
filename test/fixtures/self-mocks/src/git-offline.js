const mockData = require('./mock-dl-data.js')

module.exports = gitOffline

function gitOffline(spec, dlData, opts, next) {
  const tarballPath = mockData.getFilename(spec.raw)
  if (!tarballPath)
    next(new Error(`Test is misconfigured, don't know about ${spec.raw}`))
  else next(null, tarballPath)
}
