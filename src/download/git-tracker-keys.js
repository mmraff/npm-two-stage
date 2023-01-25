const url = require('url')

const RE_GIT_REPO_SUFFIX = /\.git$/
const RE_HASH_PREFIX = /^#/

module.exports = function(npaSpec) {
  if (arguments.length == 0)
    throw new SyntaxError('No argument given')
  if (!npaSpec || typeof npaSpec != 'object' || !('type' in npaSpec))
    throw new TypeError('Argument must be a npa-package-arg parse result')
  if (npaSpec.type != 'git')
    throw new TypeError('npa-package-arg parse result for a "git" spec required')

  const result = {}
  if (!npaSpec.hosted) {
    try {
      const parsed = new url.URL(npaSpec.rawSpec)
      result.repo = parsed.host + parsed.pathname.replace(RE_GIT_REPO_SUFFIX, '')
      result.spec = parsed.hash.replace(RE_HASH_PREFIX, '')
    }
    catch (err) { // It will be a url.URL parse error
      throw new TypeError('Invalid URL in npa-package-arg object:', npaSpec.rawSpec)
    }
  }
  else {
    result.repo = `${npaSpec.hosted.domain}/${npaSpec.hosted.path()}`
    result.spec = npaSpec.hosted.committish || ''
  }
  return result
}
