module.exports = async (npm, arb) => {
  // Don't know what's needed yet, but the actual doesn't seem to resolve
  // to anything, it justs writes the npmNode.path npmrc file, then calls
  // reifyOutput, which logs results using npm.output
  return Promise.resolve()
}

