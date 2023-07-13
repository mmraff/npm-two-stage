class MockLogFiles {
  static ctorListener

  #files = []
  #isOn = false
  #msgs = []
  #path
  #logsMax
  #openError = false

  constructor () {
    this.#isOn = true
    if (typeof MockLogFiles.ctorListener === 'function') {
      MockLogFiles.ctorListener(this)
      MockLogFiles.ctorListener = undefined
    }
  }

  off () {
    this.#isOn = false
  }

  load ({ path, logsMax = Infinity } = {}) {
    // dir is user configurable and is required to exist so
    // this can error if the dir is missing or not configured correctly
    this.#path = path
    this.#logsMax = logsMax

    // This is how we simulate a bad logfile case
    if (this.#openError) {
      return
    }

    if (this.#logsMax > 0) {
      const count = 0
      const f = `${this.#path}debug-${count}.log`
      this.#files.push(f)
    }
  }

  log (...args) {
    if (!this.#isOn)
      throw new Error('MockLogFiles cannot log when off')
    this.#msgs.push(args)
  }

  get files () { // verbatim
    return this.#files
  }

  get messages () {
    return this.#msgs
  }

  setOpenError () {
    this.#openError = true
  }
}

module.exports = MockLogFiles
