module.exports.getContents = getContents
function getContents (pkg, target, filename, silent) {
  // The results of the actual function are not used in git-offline,
  // so we won't even bother to mock results here.
  return Promise.resolve()
}
