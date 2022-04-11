// Extracted from actual script:
// The bare minimum needed to support offliner.js
'use strict'

const URL = require('url').URL

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

module.exports.trackerKeys = trackerKeys

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

