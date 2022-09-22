const URL = require('url').URL
const mockCommitHash = require('../../../../lib/mock-commit-hash')

// MOCK utilities
const config = {}
// To ensure we give a consistent answer if the same spec is
// used for another query, fetchManifest() or resolve():
const hashCache = {}
const errorCfg = {
  fetchManifest: { throwIt: false }
}
module.exports.setTestConfig = function(data) {
  for (let prop in hashCache) delete hashCache[prop]
  for (let prop in config) delete config[prop]
  // Assumes data is an object in which keys are git specs:
  for (let spec in data) {
    if (!data[spec]) {
      config[spec] = null
      continue
    }
    config[spec] = { ...data[spec] }
    if (data[spec]._sha) hashCache[spec] = data[spec]._sha
    // But when do we ever not have a _sha?
  }
}
module.exports.setErrorState = (fnName, state, errCode, exitcode) => {
  if (!errorCfg[fnName])
    throw new Error(`Unrecognized export "${fnName}", can't setErrorState`)
  errorCfg[fnName].throwIt = state
  errorCfg[fnName].code = errCode
  errorCfg[fnName].exitcode = exitcode
}

// Exports of actual auxGit
module.exports.trackerKeys = trackerKeys
module.exports.fetchManifest = fetchManifest
module.exports.resolve = resolve

// Verbatim from actual module from here to END comment -----------------------
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
      result.repo = parsed.host + parsed.pathname.replace(/\.git$/, '')
      // A semver version expression after the hashmark will get URI-encoded
      // by the URL constructor, so we apply decoding regardless of the kind
      // of value of the hash expression ("committish")
      result.spec = decodeURIComponent(parsed.hash.replace(/^#/, ''))
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

function fetchManifest(npaSpec, opts) {
  if (npaSpec.hosted && npaSpec.hosted.getDefaultRepresentation() === 'shortcut') {
    return Promise.resolve().then(() => {
      if (!npaSpec.hosted.git()) {
        throw new Error(`No git url for ${npaSpec.raw}`)
      }
      return plainManifest(npaSpec.hosted.git(), npaSpec, opts)
    }).catch(err => {
      if (!npaSpec.hosted.https()) {
        throw err
      }
      return plainManifest(npaSpec.hosted.https(), npaSpec, opts)
    }).catch(err => {
      if (!npaSpec.hosted.sshurl()) {
        throw err
      }
      return plainManifest(npaSpec.hosted.sshurl(), npaSpec, opts)
    })
  }
  else {
    // If it's not a shortcut, don't do fallbacks.
    return plainManifest(npaSpec.fetchSpec, npaSpec, opts)
  }
}

const RE_COMMIT_TAIL = /(?:#.*)?$/
const RE_HEX40CH = /^[a-f0-9]{40}$/

function plainManifest (repo, npaSpec, opts) {
  const rawRef = npaSpec.gitCommittish || npaSpec.gitRange
  return resolve(
    repo, npaSpec, npaSpec.name, opts
  ).then(ref => {
    if (ref) {
      const resolved = npaSpec.saveSpec.replace(RE_COMMIT_TAIL, `#${ref.sha}`)
      return {
        _repo: repo,
        _resolved: resolved,
        _spec: npaSpec,
        _ref: ref,
        _rawRef: npaSpec.gitCommittish || npaSpec.gitRange,
        _uniqueResolved: resolved,
        _integrity: false,
        _shasum: false
      }
    }
    else {
      // We're SOL and need a full clone :(
      //
      // If we're confident enough that `rawRef` is a commit SHA,
      // then we can at least get `finalize-manifest` to cache its result.
      const resolved = npaSpec.saveSpec.replace(
        RE_COMMIT_TAIL, /*istanbul ignore next */ rawRef ? `#${rawRef}` : ''
      )
      return {
        _repo: repo,
        _rawRef: rawRef,
        _resolved: /*istanbul ignore next */ rawRef && rawRef.match(RE_HEX40CH) && resolved,
        _uniqueResolved: /*istanbul ignore next */ rawRef && rawRef.match(RE_HEX40CH) && resolved,
        _integrity: false,
        _shasum: false
      }
    }
  })
}
// END OF Verbatim from actual module -----------------------------------------

function resolve(url, npaSpec, name, opts) {
  const errCfg = errorCfg.fetchManifest
  if (errCfg.throwIt) {
    const err = new Error('Dummy error from git-aux.js mock')
    if (errCfg.code) err.code = errCfg.code
    if (errCfg.exitcode) err.exitcode = errCfg.exitcode
    return Promise.reject(err)
  }
  if (!(npaSpec.rawSpec in config))
    return Promise.reject(new Error('(MOCK git-aux) exited with error code: 128'))

  const testData = config[npaSpec.rawSpec]
  // When the clients of this mock configure an empty object for the given spec,
  // it is to signal that this module should supply its own mock data.
  // If the spec is configured with null, that's a different case!
  if (testData && Object.keys(testData).length == 0) {
    if (!(npaSpec.rawSpec in hashCache))
      hashCache[npaSpec.rawSpec] = mockCommitHash()
    const sha = hashCache[npaSpec.rawSpec]
    const result = { sha: sha, ref: 'master', type: 'branch' }
    if (opts.multipleRefs)
      result.allRefs = [ 'master', 'optimus' ]
  }
  return Promise.resolve(testData)
}
