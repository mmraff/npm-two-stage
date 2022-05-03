module.exports = (pkg, stage, wd, moreOpts, cb) => {
  if (typeof cb != 'function') cb = moreOpts
  cb()
}
