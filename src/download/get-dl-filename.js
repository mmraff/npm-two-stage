/*
  Try to find the intended filename for a download in an HTTP response.
  The official place to look for this is in the Content-Disposition header,
  but it has been known to appear elsewhere, so this code may get updated
  to account for that.
  References include RFC 2183, RFC 2616, and RFC 6266.
*/

module.exports = getDownloadFilename

function getDownloadFilename(response)
{
  var contentDisp = response.headers['content-disposition']
    , filename = null
    , matches
    , endIdx

  if (!contentDisp) return null

  matches = contentDisp.match(/;\s*filename\s*=\s*(.+)(?:;.*)?$/)
  if (matches) {
    filename = matches[1].trim()
    endIdx = filename.length - 1
    if ((filename.charAt(0) == '"' && filename.charAt(endIdx) == '"') ||
        (filename.charAt(0) == "'" && filename.charAt(endIdx) == "'")) {
      filename = filename.slice(1, -1)

      // J.I.C.: surrounding whitespace inside the quotemarks?
      filename = filename.trim()
    }

    // RFC 2616, 19.5.1 Content-Disposition:
    // "The receiving user agent SHOULD NOT respect any directory path
    // information present in the filename-parm parameter..."
    // RFC 6266:
    // "...never trust folder name information in the filename parameter,
    // for instance by stripping all but the last path segment..."
    if (filename.search(/[/\\]/) != -1) {
      filename = filename.replace(/^.+[/\\]/, '')
    }

    // Be paranoid about filename prefix: most non-alphanumerics are bad news
    if (/^\W/.test(filename)) {
      filename = filename.replace(/^\W+/, '')
    }
  }

  return filename || null
}
