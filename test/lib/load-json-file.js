const { promisify } = require('util')
const readFileAsync = promisify(require('fs').readFile)

module.exports = (filepath) =>
  readFileAsync(filepath, 'utf8').then(str => {
    let data
    // Strip BOM, if any
    if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1)
    try { data = JSON.parse(str) }
    catch (parseErr) {
      const err = new Error(
        `Failed to parse JSON from ${filepath}: ${parseErr.message}`
      )
      return err
    }
    return data
  })
