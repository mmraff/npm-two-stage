const path = require('path')
const npa = require('npm-package-arg')
const mockData = require('./mock-dl-data')

module.exports = function(dep, opts, next) {
  /*
   * Actual module requires that dep is the result of npa(someSpec).
   * Actual module does nothing with opts unless the dlTracker reports
      that it has data matching dep, but without a filename - which
	  probably means that there's a git clone directory for dep, in
	  which case opts is passed along to gitOffline().
   * next is the callback, which gets npa(localTarballPath).
   */
  try {
    const filename = mockData.getFilename(dep)
    if (!filename)
      throw new Error(`Download Tracker knows nothing about ${dep.raw}`)
    const offlineDep = npa(path.join(mockData.path, filename))
    next(null, offlineDep)
  }
  catch (err) { next(err) }
}

