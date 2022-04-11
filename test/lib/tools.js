const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const renameAsync = promisify(fs.rename)

// Because this module uses file-tools in support of testing, its exports
// should not be used until the test suite for file-tools is run.
const ft = require('../../lib/file-tools')

module.exports.copyFreshMockNpmDir = function(where) {
  relativePath = path.join(__dirname, '..', 'fixtures', 'mock-npm')
  return ft.graft(relativePath, where)
  .then(() => {
    const startDir = process.cwd()
    process.chdir(where)
    return renameAsync('mock-npm', 'npm')
    .then(() => process.chdir(startDir))
    .catch(err => {
      process.chdir(startDir)
      throw err
    })
  })
}
