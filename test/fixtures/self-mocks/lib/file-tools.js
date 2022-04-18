const cfg = {
  prune: { throwIt: false },
  removeFiles: { throwIt: false },
  graft: { throwIt: false }
}

function dummyMaybeThrow(fnName) {
  if (cfg[fnName].throwIt) {
    const err = new Error('Dummy error from file-tools mock')
    if (cfg[fnName].code) err.code = cfg[fnName].code
    return Promise.reject(err)
  }
  return Promise.resolve()
}

module.exports = {
  setEmitter: () => {},
  prune: () => dummyMaybeThrow('prune'),
  removeFiles: () => dummyMaybeThrow('removeFiles'),
  graft: () => dummyMaybeThrow('graft'),
  setErrorState: (fnName, state, errCode) => {
    cfg[fnName].throwIt = state
    cfg[fnName].code = errCode
  }
}
