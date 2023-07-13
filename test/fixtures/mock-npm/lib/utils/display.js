class MockDisplay {
  static ctorListener

  #config
  #msgs = []

  constructor () {
    if (typeof MockDisplay.ctorListener === 'function') {
      MockDisplay.ctorListener(this)
      MockDisplay.ctorListener = undefined
    }
  }

  off () {
  }

  load (config) {
    this.#config = { ...config }
  }

  log (...args) {
    this.#msgs.push([ ...args ])
  }

  get config () {
    return this.#config
  }

  get messages () {
    return this.#msgs
  }
}

module.exports = MockDisplay
