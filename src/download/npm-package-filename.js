/*
TODO:
* Add links (with labels) to the reference documents (RFCs, npmjs.org, etc.)
*/
module.exports = npmPackageFilename = {
  parse: parseFilename,
  hasTarballExtension: hasTarballExt,
  extractVersion: extractVersion
}

/*
Let c = successful capture array; then c[0] is entire match;
c[1] is the bare name;
c[2] is numeric triplet of version string;
c[3] is pre-release identifier(s);
c[4] is build metadata; and
c[5] is the (tarball) file extension, '.'-prefixed.

c[1],c[3],c[4] & c[5] are optional, so each may be undefined.
c[1] is made optional so that the last component of (say) a github URL can be parsed,
 in the case where a version string and filename can't be derived elsewhere.
*/
var SEMVER_NUM_LOOSE = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)'
  , SEMVER_PRERELEASE = '(?:\\d+|\\d*[a-zA-Z-][a-zA-Z0-9-]*)(?:\\.(?:\\d+|\\d*[a-zA-Z-][a-zA-Z0-9-]*))*'
  , SEMVER_BUILD = '[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*?'
  , TARBALL_EXT = '\\.[tT](?:[gG][zZ]|[aA][rR](?:\\.[gG][zZ])?)'
  , RE_TARBALL_EXT = new RegExp(TARBALL_EXT + '$')
  , RE_PKGFILENAME = new RegExp([
      '^([a-zA-Z0-9][a-zA-Z0-9_.]*(?:-(?:(?:0|[1-9]\\d*)(?:\\.(?:(?:0|[1-9]\\d*)\\.?)?)?|(?:[a-zA-Z_.]|(?:0|[1-9]\\d*)(?:[a-zA-Z_]|\\.(?:[a-zA-Z_.]|(?:0|[1-9]\\d*)(?:[a-zA-Z_]|\\.[a-zA-Z_.]))))[a-zA-Z0-9_.]*))*)',
      '-(', SEMVER_NUM_LOOSE, ')',
      '(?:-?(', SEMVER_PRERELEASE, '))?',
      '(\\+', SEMVER_BUILD, ')?',
      '(', TARBALL_EXT, ')$'
    ].join(''))
  , RE_VERSION = new RegExp([
      SEMVER_NUM_LOOSE,
      '(?:-?', SEMVER_PRERELEASE, ')?',
      '(?:\\+', SEMVER_BUILD, ')?'
    ].join(''))

//npmPackageFilename.RE = RE_PKGFILENAME

function parseFilename(str)
{
  var matches = RE_PKGFILENAME.exec(str)

  if (! matches) return null
  return {
    input: matches[0],
    packageName: matches[1] || null,
    versionComparable: matches[2] + (matches[3] ? '-' + matches[3] : ''),
    versionNumeric: matches[2],
    prerelease: matches[3] || null,
    build: matches[4] || null,
    extension: matches[5] || null
  }
}

// Works with a tarball filename even if it doesn't conform to all
// package name rules defined here.
function hasTarballExt(str)
{
  return RE_TARBALL_EXT.test(str)
}

// Works with a string that contains a semver 2.0-compliant version expression,
// even if it doesn't conform to all package name rules defined here.
function extractVersion(str)
{
  var matches = RE_VERSION.exec(str)
    , ver
  if (!matches) return null
  if (hasTarballExt(matches[0])) {
    ver = matches[0].replace(RE_TARBALL_EXT, '')
  }
  else ver = matches[0]
  return ver
}

