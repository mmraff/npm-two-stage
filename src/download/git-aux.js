'use strict'

const URL = require('url').URL

const BB = require('bluebird')
const pickManifest = require('npm-pick-manifest')
const utilGit = require('pacote/lib/util/git')

module.exports.trackerKeys = trackerKeys
module.exports.fetchManifest = fetchManifest
module.exports.resolve = resolve

const RE_GIT_REPO_SUFFIX = /\.git$/
const RE_HASH_PREFIX = /^#/

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

// fetchManifest: Borrowed from pacote/lib/fetchers/git.js
// as combination of manifest() and hostedManifest()
function fetchManifest(npaSpec, opts) {
  if (npaSpec.hosted && npaSpec.hosted.getDefaultRepresentation() === 'shortcut') {
    return BB.resolve(null).then(() => {
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
      const resolved = npaSpec.saveSpec.replace(RE_COMMIT_TAIL, rawRef ? `#${rawRef}` : '')
      return {
        _repo: repo,
        _rawRef: rawRef,
        _resolved: rawRef && rawRef.match(RE_HEX40CH) && resolved,
        _uniqueResolved: rawRef && rawRef.match(RE_HEX40CH) && resolved,
        _integrity: false,
        _shasum: false
      }
    }
  })
}

// resolve: Borrowed from pacote/lib/fetchers/git.js; improved
/*----------------------------------------------------------------------------
There's a problem with the line in the above file that uses spec.gitCommittish:
If the package spec did not have a gitCommittish (the tail following #), then
that line causes the function to disregard potentially usable results.
In particular, there's usually a 'master' ref (it is/was the git default).
Cases where there is no 'master' ref:
- The repository has no commits yet
- The user has supplied the option to set a different initial branch name
  [-b | --initial-branch]
- The user has configured a different default (init.defaultBranch)
- There once was a 'master' ref, but the user removed it

Also, added option to get all the tags bound to the resolved commit.
In this case, a new property is added to the result: allRefs.
*/
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
          if (!(committish in remoteRefs.refs))
            // Whatever! Take the first available, hope for the best
            committish = Object.keys(remoteRefs.refs)[0]
            // It's still possible that committish is undefined at this point
        }
        //result = BB.resolve(remoteRefs.refs[committish]) // AFAIK, don't need BB.resolve for return val from a Promise
        result = remoteRefs.refs[committish]
      }
      else {
        //result = BB.resolve( // AFAIK, don't need BB.resolve for return val from a Promise
        //result = remoteRefs.refs[committish] || remoteRefs.refs[remoteRefs.shas[committish]]
        // An interesting phenomenon in that 2nd expression:
        // * if exists, remoteRefs.shas[committish] is an Array
        // * if remoteRefs.shas[committish] has only one element, it evaluates to that one element
        //   when used as a key (remoteRefs.refs[remoteRefs.shas[committish]])
        // * but if it has multiple elements, using it as a key into remoteRefs.refs gets you nothing.

        result = remoteRefs.refs[committish] ||
                 (remoteRefs.shas[committish] && remoteRefs.refs[remoteRefs.shas[committish][0]])
      }
      if (result && opts.multipleRefs) {
        result.allRefs = remoteRefs.shas[result.sha]
      }
    }
    return result
  })
}
