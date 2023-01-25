const tap = require('tap')
const cmdList = require('../src/utils/cmd-list')

const objects = [ 'aliases', 'shorthands', 'affordances' ]
const lists = [ 'cmdList', 'plumbing', 'shellouts' ]

tap.test('All exports covered', t1 => {
  for (const item in cmdList)
    t1.ok(objects.includes(item) || lists.includes(item))
  t1.end()
})

tap.test('object exports', t1 => {
  for (const o of objects) {
    t1.type(cmdList[o], 'object')
    t1.equal(Object.keys(cmdList[o]).length > 0, true)
    for (const prop in cmdList[o]) {
      const value = cmdList[o][prop]
      t1.type(value, 'string')
      t1.equal(value.length > 0, true)
    }
  }
  t1.end()
})

tap.test('array exports', t1 => {
  for (const name of lists) {
    const list = cmdList[name]
    t1.type(list, Array)
    t1.equal((new Set(list)).size, list.length)
    for (const item of list) {
      t1.type(item, 'string')
      t1.equal(item.length > 0, true)
    }
  }
  t1.end()
})

tap.test('aliases is the union of shorthands and affordances', t1 => {
  const notRepresented = Object.keys(cmdList.aliases).filter(
    item => !(item in cmdList.shorthands || item in cmdList.affordances)
  )
  t1.same(notRepresented, [])
  for (const item in cmdList.shorthands)
    t1.equal(cmdList.shorthands[item], cmdList.aliases[item])
  for (const item in cmdList.affordances)
    t1.equal(cmdList.affordances[item], cmdList.aliases[item])
  t1.end()
})

tap.test('aliases: each item corresponds to a command', t1 => {
  const commands = cmdList.cmdList
  const aliases = cmdList.aliases
  for (const item in aliases) {
    const aliased = aliases[item]
    // Give items a chance to be double-aliased, but no deeper:
    t1.ok(commands.includes(aliased) || commands.includes(aliases[aliased]))
  }
  t1.end()
})

