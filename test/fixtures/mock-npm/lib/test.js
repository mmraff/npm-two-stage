const npa = require('npm-package-arg')

module.exports = function(pkgSpec) {
  return npa(pkgSpec)
}

