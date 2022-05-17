const URL = require('url').URL
const mockCommitHash = require('../../../../lib/mock-commit-hash')

const RE_GIT_REPO_SUFFIX = /\.git$/
const RE_HASH_PREFIX = /^#/

module.exports.trackerKeys = trackerKeys
module.exports.fetchManifest = fetchManifest
module.exports.resolve = resolve

// TODO: should be able to drop this? Check to see if offliner test depends on an error
function expectNpaGitResult(obj) {
  if (obj === undefined || obj == null)
    throw new SyntaxError('No argument given')
  if (typeof obj != 'object')
    throw new TypeError('Given argument is not an object')
  if (obj.type != 'git')
    throw new TypeError(`Expected type field value 'git'; given type value: ${obj.type}`)
}

function trackerKeys(npaSpec) {
  expectNpaGitResult(npaSpec)

  const result = {}
  if (!npaSpec.hosted) {
    try {
      const parsed = new URL(npaSpec.rawSpec)
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

// To ensure we give a consistent answer if the same spec is
// used for another query, fetchManifest() or resolve()
const hashCache = {}

function fetchManifest(npaSpec, opts) {
  const hosted = npaSpec.hosted
  const repo = hosted.git() || hosted.https() || npaSpec.hosted.sshurl()
  let resolved = npaSpec.saveSpec
  if (!(/^[a-f0-9]{40}$/.test(resolved))) {
    if (!(npaSpec.raw in hashCache))
      hashCache[npaSpec.raw] = mockCommitHash()
    const sha = hashCache[npaSpec.raw]
    resolved = resolved.replace(/(?:#.*)?$/, `#${sha}`)
  }

  const result = {
    _repo: repo,
    _resolved: resolved,
    _spec: npaSpec,
    _ref: { sha: sha, ref: 'master', type: 'branch' },
    _rawRef: npaSpec.gitCommittish || npaSpec.gitRange,
    _uniqueResolved: resolved,
    _integrity: false,
    _shasum: false
  }
  if (opts.multipleRefs)
    result._ref.allRefs = [ 'master', 'megatron', result._ref.sha ]

  return Promise.resolve(result)
}

function resolve(url, npaSpec, name, opts) {
  if (!(npaSpec.raw in hashCache))
    hashCache[npaSpec.raw] = mockCommitHash()
  const sha = hashCache[npaSpec.raw]
  const result = { sha: sha, ref: 'master', type: 'branch' }
  if (opts.multipleRefs)
    result.allRefs = [ 'master', 'optimus', result.sha ]

  return Promise.resolve(result)
}
