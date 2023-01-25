const tap = require('tap')
const config = require('../src/download/config')

const funcs = [ 'get', 'set', 'freeze' ]
const knownProps = [ 'dlTracker', 'opts', 'cache', 'log' ]
const unknownProps = [ 'NO_SUCH_PROPERTY', 42, true, function(){}, new Date() ]

tap.test(`should export functions ${funcs.map(v => `\`${v}\``).join(', ')}`, t1 => {
  t1.hasProps(config, funcs)
  t1.end()
})

tap.test('config.get', t1 => {
  t1.test('should return `undefined` for unrecognized property', t2 => {
    for (let i = 0; i < unknownProps.length; ++i)
      t2.equal(config.get(unknownProps[i]), undefined)
    t2.end()
  })
  t1.test('should return `null` for known property that is yet to be set', t2 => {
    for (let i = 0; i < knownProps.length; ++i)
      t2.equal(config.get(knownProps[i]), null)
    t2.end()
  })
  t1.end()
})

tap.test('config.set, before config.freeze has been called', t1 => {
  t1.test('should throw on attempt to set unrecognized property', t2 => {
    for (let i = 0; i < unknownProps.length; ++i)
      t2.throws(() => config.set(unknownProps[i]))
    t2.end()
  })
  t1.test('should succeed if used to set a recognized property', t2 => {
    const value = 'SUCCESS'
    for (let i = 0; i < knownProps.length; ++i) {
      const prop = knownProps[i]
      t2.doesNotThrow(() => config.set(prop, value + (i+1)))
      t2.equal(config.get(prop), value + (i+1))
    }
    t2.end()
  })
  t1.end()
})

tap.test('config.freeze', t1 => {
  t1.test('should not throw on first time used', t2 => {
    t2.doesNotThrow(() => config.freeze())
    t2.end()
  })
  t1.test('should throw after the first time used', t2 => {
    t2.throws(() => config.freeze())
    t2.end()
  })
  t1.end()
})

tap.test('config.set, after config.freeze has been called', t1 => {
  t1.test('should throw on attempt to set unrecognized property', t2 => {
    for (let i = 0; i < unknownProps.length; ++i)
      t2.throws(() => config.set(unknownProps[i]))
    t2.end()
  })
  t1.test('should throw on attempt to set recognized property; value remains unchanged', t2 => {
    const newValue = 'LATECOMER'
    for (let i = 0; i < knownProps.length; ++i) {
      const prop = knownProps[i]
      const oldValue = config.get(prop)
      t2.throws(() => config.set(prop, newValue))
      t2.equal(config.get(prop), oldValue)
    }
    t2.end()
  })
  t1.end()
})

