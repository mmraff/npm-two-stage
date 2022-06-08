// Stuff copied selectively from actual module
const url = require('url')

const NUMBER = '(?:0|[1-9]\\d*)'
const NUMERIC_TRIPLET = [ NUMBER, NUMBER, NUMBER ].join('\\.')
const TARBALL_EXT = '\\.[tT](?:[gG][zZ]|[aA][rR](?:\\.[gG][zZ])?)'
const RE_TARBALL_EXT = new RegExp(TARBALL_EXT + '$')
const RE_AMBIGUOUS_VERSION = new RegExp([
  '-', NUMERIC_TRIPLET, '-', NUMERIC_TRIPLET,
  '(?:[+-]|\\.', TARBALL_EXT, '$|$)?'
].join(''))

function isVersionAmbiguous(name, version) {
  const str = version ? name + '-' + version : name
  return RE_AMBIGUOUS_VERSION.test(str)
}

// download.js only uses makeTarballName
module.exports.makeTarballName = function(data) {
  const defaultExt = '.tar.gz'
  let raw
  switch (data.type) {
    case 'semver':
      if (isVersionAmbiguous(data.name, data.version))
        raw = [ data.name, '%', data.version, defaultExt ].join('')
      else
        raw = [ data.name, '-', data.version, defaultExt ].join('')
      break;
    case 'git':
      raw = [
        data.domain, '/', data.path, '#', data.commit, defaultExt
      ].join('')
      break;
    case 'url':
      const u = url.parse(data.url)
      if (!(u.protocol && u.slashes && u.host && u.path) || u.path === '/' || u.href !== data.url)
        throw new Error('value given for url does not look usable')
      raw = u.host + u.path
      if (!RE_TARBALL_EXT.test(raw)) raw += defaultExt
      break;
    default:
      throw new Error(`Type '${data.type}' not recognized`)
  }
  return encodeURIComponent(raw)
}
