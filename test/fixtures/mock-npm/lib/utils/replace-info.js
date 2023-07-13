const isString = (v) => typeof v === 'string'
const replacement = 'HELLO_FROM_MOCK_REPLACE_INFO'

module.exports = arg => {
  //console.log('Mock replace-info input:', arg)
  if (isString(arg) && arg.startsWith('npm_')) {
    return replacement
  } else if (Array.isArray(arg)) {
    return arg.map((a) => (isString(a) && a.startsWith('npm_')) ? replacement : a)
  }

  return arg
}
