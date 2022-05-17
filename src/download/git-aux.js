'use strict'

const URL = require('url').URL

const pickManifest = require('npm-pick-manifest')
const utilGit = require('pacote/lib/util/git')

module.exports.trackerKeys = trackerKeys
module.exports.fetchManifest = fetchManifest
module.exports.resolve = resolve

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

// fetchManifest: Borrowed from pacote/lib/fetchers/git.js
// as combination of manifest() and hostedManifest()
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

// plainManifest: Borrowed from pacote/lib/fetchers/git.js
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

// resolve: Borrowed from pacote/lib/fetchers/git.js, with mods
// Added option to get all the tags bound to the resolved commit.
// In this case, a new property is added to the result: allRefs.
function resolve(url, npaSpec, name, opts) {
  const isSemver = !!npaSpec.gitRange
  return utilGit.revs(url, opts).then(remoteRefs => {
    let result = null
    if (isSemver) {
      result = pickManifest(
        {
          versions: remoteRefs.versions,
          'dist-tags': remoteRefs['dist-tags'],
          name: name
        },
        npaSpec.gitRange, opts
      )
    }
    else if (remoteRefs) {
      let committish = npaSpec.gitCommittish
      if (!committish) {
        committish = 'master'
        if (!(committish in remoteRefs.refs)) {
          committish = 'main'
          /* istanbul ignore else: similar enough to above that it's not worth the extra test code */
          if (!(committish in remoteRefs.refs))
            // Whatever! Take the first available, hope for the best
            committish = Object.keys(remoteRefs.refs)[0]
            // It's still possible that committish is undefined at this point
        }
        result = remoteRefs.refs[committish]
      }
      else {
        //result = remoteRefs.refs[committish] || remoteRefs.refs[remoteRefs.shas[committish]]
        // The above line is taken directly from the pacote code.
        // There is a problem in returning the result of that 2nd expression:
        // * if exists, remoteRefs.shas[committish] is an Array
        // * if remoteRefs.shas[committish] has only one element, it evaluates to that one element
        //   when used as a key (e.g., remoteRefs.refs[remoteRefs.shas[committish]])
        // * but if it has multiple elements, using it as a key into remoteRefs.refs gets you nothing.

        result = remoteRefs.refs[committish] ||
                 (remoteRefs.shas[committish] && remoteRefs.refs[remoteRefs.shas[committish][0]])
      }
      /* istanbul ignore else: we always want all refs here, right? */
      if (result && opts.multipleRefs) {
        result.allRefs = remoteRefs.shas[result.sha]
      }
    }
    /* Invisible else case:  I don't believe git.revs EVER returns nothing */

    return result
  })
}
