const tap = require('tap')
const oldCmdList = require('../node_modules/npm/lib/utils/cmd-list')
const newCmdList = require('../src/utils/cmd-list')

const objects = [ 'aliases' ]
const lists = [ 'commands' ]

tap.test('All exports covered', t1 => {
  for (const item in newCmdList) {
    if (!objects.includes(item) && !lists.includes(item)) {
      t1.fail(`unexpected export "${item}"`)
    }
  }
  t1.end()
})

tap.test('object exports', t1 => {
  for (const o of objects) {
    t1.type(newCmdList[o], 'object')
    t1.equal(Object.keys(newCmdList[o]).length > 0, true)
    for (const prop in newCmdList[o]) {
      const value = newCmdList[o][prop]
      const type = typeof value
      if (type !== 'string') {
        t1.fail(`Value of ${o}.${prop} is not a string; found ${type}`)
      }
      if (value.length == 0) {
        t1.fail(`${o}.${prop} is an empty string`)
      }
    }
  }
  t1.end()
})

tap.test('array exports', t1 => {
  for (const name of lists) {
    const list = newCmdList[name]
    t1.type(list, Array)
    t1.equal((new Set(list)).size, list.length)
    for (const item of list) {
      t1.type(item, 'string')
      t1.equal(item.length > 0, true)
      const type = typeof item
      if (type !== 'string') {
        t1.fail(`Item in ${name} list is not a string; found ${type}`)
      }
      if (item.length == 0) {
        t1.fail(`Empty string found on ${name} list`)
      }
    }
  }
  t1.end()
})

tap.test('differences between modified and original', t1 => {
  const modifiedOldCmds =
    [ ...oldCmdList.commands, 'download' ].sort()
  const newCmds = [ ...newCmdList.commands ].sort()
  t1.strictSame(newCmds, modifiedOldCmds)

  const modifiedOldAliases = { ...oldCmdList.aliases, dl: 'download' }
  t1.strictSame(newCmdList.aliases, modifiedOldAliases)

  t1.end()
})
