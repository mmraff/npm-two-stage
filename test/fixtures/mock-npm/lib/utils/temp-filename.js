const os = require('os')
const path = require('path')
module.exports = function(prefix) {
  return path.join(os.tmpdir(), prefix + '_npm-two-stage_test')
}
