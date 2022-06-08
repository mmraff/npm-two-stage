'use strict'

module.exports = function usage (cmd, txt, opt) {
  if (opt) {
    txt += '\n\ncommon options: ' + opt
  }
  return txt
}
