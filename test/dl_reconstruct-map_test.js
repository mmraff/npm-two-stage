const tap = require('tap')
const mockCommitHash = require('./lib/mock-commit-hash')
const mockLog = require('./fixtures/mock-npm/lib/utils/log-shim')
const npf = require('../src/download/npm-package-filename')

let errReaddir = null
const dirList = []
const reconstructMap = tap.mock('../src/download/reconstruct-map', {
  'fs/promises': {
    readdir (...args) {
      if (args.length !== 1) {
        return Promise.reject(new Error(
          'mock readdir: expected 1 arg, actual ' + args.length
        ))
      }
      return errReaddir ? Promise.reject(errReaddir) : Promise.resolve(dirList)
    }
  }
})

const goodData = {
  semver: [
    { name: 'dummy', version: '1.2.3' },
    { name: 'dummy', version: '1.2.4' },
    { name: 'standin', version: '3.2.1' }
  ],
  git: [
    {
      domain: 'gittar.net', path: 'gtUser/gtProject',
      commit: mockCommitHash()
    },
    {
      domain: 'gittar.net', path: 'gtUser/gtProject',
      commit: mockCommitHash()
    },
    {
      domain: 'github.com', path: 'ghUser/ghProject',
      commit: mockCommitHash()
    }
  ],
  url: [
    {
      url: 'https://dark.net/xyz/mystery-project.tgz'
    },
    {
      url: 'https://grey.net/asdf/grey-project.tar.gz'
    }
  ]
}
for (const type in goodData) {
  for (const item of goodData[type]) {
    const filenameData = { type, ...item }
    item.filename = npf.makeTarballName(filenameData)
  }
}
for (const item of goodData.git) {
  item.repo = npf.parse(item.filename).repo
}
for (const item of goodData.url) {
  item.storedUrl = npf.parse(item.filename).url
}

tap.test('Misuse', t1 => {
  t1.rejects(reconstructMap(), /No path given/)
  for (const item of [ undefined, null, '' ]) {
    t1.rejects(reconstructMap(item), /No path given/)
  }
  for (const item of [ true, 42, {}, [], function(){}, new String('Hi') ]) {
    t1.rejects(reconstructMap(item), TypeError)
  }

  // logger argument
  for (const item of [ true, 42, 'Howdy', function(){} ]) {
    t1.rejects(reconstructMap('dummyDir', item), TypeError)
  }

  const testLogger = {}

  for (const item of [ 'error', 'warn', 'info', 'verbose' ]) {
    t1.rejects(
      reconstructMap('dummyDir', testLogger),
      `logger must have a '${item}' method`
    )
    testLogger[item] = {}
    t1.rejects(
      reconstructMap('dummyDir', testLogger),
      `logger '${item}' property is not a function`
    )
    testLogger[item] = function() {}
  }
  t1.end()
})

tap.test('Empty directory and a logger', t => {
  reconstructMap('dummyDir', mockLog)
  .then(result => {
    t.same(result, {})
    t.same(mockLog.getList(), [])
    t.end()
  })
})

tap.test('Directory with package tarballs', t => {
  const s = goodData.semver
  const g = goodData.git
  const u = goodData.url
  const list = []
  for (const item of s) list.push(item.filename)
  for (const item of g) list.push(item.filename)
  for (const item of u) list.push(item.filename)
  dirList.splice(0, 0, ...list)
  mockLog.purge()
  reconstructMap('dummyDir')
  .then(result => {
    t.same(
      result,
      {
        semver: {
          // s[0] and s[1] have the same name, so should become grouped
          [s[0].name]: {
            [s[0].version]: { filename: s[0].filename },
            [s[1].version]: { filename: s[1].filename }
          },
          [s[2].name]: {
            [s[2].version]: { filename: s[2].filename }
          }
        },
        git: {
          // g[0] and g[1] have the same repo, so should become grouped
          [g[0].repo]: {
            [g[0].commit]: { filename: g[0].filename },
            [g[1].commit]: { filename: g[1].filename }
          },
          [g[2].repo]: {
            [g[2].commit]: { filename: g[2].filename }
          }
        },
        url: {
          [u[0].storedUrl]: { filename: u[0].filename },
          [u[1].storedUrl]: { filename: u[1].filename },
        }
      }
    )
    t.same(mockLog.getList(), [])
    t.end()
  })
})

// The only times we can expect log messages are:
// * npf.parse() fails to parse a filename - easy enough to test
// * npf.parse() parses an unhandled type! Can't do that.

tap.test('Directory with file with unparseable name', t => {
  const intruderName = 'this-is-not-a-tarball.zip'
  dirList.splice(0) // empty it
  dirList.push(intruderName)
  reconstructMap('dummyDir')
  .then(result => {
    t.same(result, {})
    mockLog.purge()
    return reconstructMap('dummyDir', mockLog)
  })
  .then(result => {
    t.same(result, {})
    t.same(mockLog.getList()[0], {
      level: 'warn', prefix: 'DownloadTracker',
      message: `failed to parse filename '${intruderName}'`
    })
    t.end()
  })
})

