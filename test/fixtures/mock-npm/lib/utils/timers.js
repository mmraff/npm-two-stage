const EE = require('events')

class MockTimers extends EE {
  static ctorListener

  file = null

  #unfinished = new Map()
  #finished = {}
  #onTimeEnd = Symbol('onTimeEnd')
  #initialListener = null
  #initialTimer = null

  #writtenData = []

  constructor ({ listener = null, start = 'npm' } = {}) { // verbatim except where noted
    super()
    this.#initialListener = listener
    this.#initialTimer = start
    if (typeof MockTimers.ctorListener === 'function') { // mmr inserted
      MockTimers.ctorListener(this)
      MockTimers.ctorListener = undefined
    }
    this.#init()
  }

  get unfinished () { // verbatim
    return this.#unfinished
  }

  get finished () { // verbatim
    return this.#finished
  }

  #init () { // verbatim
    this.on()
    if (this.#initialListener) {
      this.on(this.#initialListener)
    }
    process.emit('time', this.#initialTimer)
    this.started = this.#unfinished.get(this.#initialTimer)
  }

  on (listener) { // verbatim
    if (listener) {
      super.on(this.#onTimeEnd, listener)
    } else {
      process.on('time', this.#timeListener)
      process.on('timeEnd', this.#timeEndListener)
    }
  }

  off (listener) { // verbatim
    if (listener) {
      super.off(this.#onTimeEnd, listener)
    } else {
      this.removeAllListeners(this.#onTimeEnd)
      process.off('time', this.#timeListener)
      process.off('timeEnd', this.#timeEndListener)
    }
  }

  time (name, fn) { // verbatim
    process.emit('time', name)
    const end = () => process.emit('timeEnd', name)
    if (typeof fn === 'function') {
      const res = fn()
      return res && res.finally ? res.finally(end) : (end(), res)
    }
    return end
  }

  load ({ path } = {}) { // verbatim
    if (path) {
      this.file = `${path}timing.json`
    }
  }

  writeFile (metadata) {
    if (!this.file) {
      return
    }

    this.#writtenData.push({ ...metadata })
  }

  #timeListener = (name) => { // verbatim
    this.#unfinished.set(name, Date.now())
  }

  #timeEndListener = (name) => { // partial
    if (this.#unfinished.has(name)) {
      const ms = Date.now() - this.#unfinished.get(name)
      this.#finished[name] = ms
      this.#unfinished.delete(name)
      this.emit(this.#onTimeEnd, name, ms)
    }
  }

  get messages () {
    return this.#writtenData
  }
}

module.exports = MockTimers
