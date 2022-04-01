// TODO: consider putting this as a static in dltracker
// Also consider exporting it from npm-package-filename, since that uses the same logic

const url = require('url')

const RE_GIT_REPO_SUFFIX = /\.git$/
const RE_HASH_PREFIX = /^#/

module.exports = npaSpec => {
  const result = {}
  if (!npaSpec.hosted) {
    try {
      const parsed = new url.URL(npaSpec.rawSpec)
      result.repo = parsed.host + parsed.pathname.replace(RE_GIT_REPO_SUFFIX, '')
      result.spec = parsed.hash.replace(RE_HASH_PREFIX, '')
    }
    catch (err) {
      return null
    }
  }
  else {
    result.repo = `${npaSpec.hosted.domain}/${npaSpec.hosted.path()}`
    result.spec = npaSpec.hosted.committish || ''
  }
  return result
}
