const path = require('path')

const npf = require('../src/download/npm-package-filename')
const mockCommitHash = require('./lib/mock-commit-hash')
const tap = require('tap')
const mockLog = require('./fixtures/mock-npm/lib/utils/log-shim')
const dltLogGetPrefix = 'DownloadTracker.getData'
function checkLogAndReset(t, start, count, matchData) {
  const logList = mockLog.getList()
  for (let c = 0; c < count; ++c) {
    t.same(logList[start + c], matchData)
  }
  mockLog.purge()
}

const fsErr = {}
const dirList = []
const fileContents = {}
const fsStats =  {}
const mockGracefulFS = {
  lstat (...args) {
    tap.equal(args.length, 2)
    if (fsErr.lstat) return process.nextTick(() => args.pop()(fsErr.lstat))
    const stats = fsStats[args[0]]
    if (!stats) {
      const err = new Error('mock lstat error')
      err.code = 'ENOENT'
      err.path = args[0]
      return process.nextTick(() => args.pop()(err))
    }
    return process.nextTick(() => args.pop()(null, stats))
  },
  readdir (...args) {
    tap.equal(args.length, 2)
    if (fsErr.readdir)
      return process.nextTick(() => args.pop()(fsErr.readdir))
    return process.nextTick(() => args.pop()(null, dirList))
  },
  readFile (...args) {
    tap.equal(args.length, 3)
    if (fsErr.readFile)
      return process.nextTick(() => args.pop()(fsErr.readFile))
    const contents = fileContents[args[0]]
    if (contents === undefined) {
      const err = new Error('mock readFile error')
      err.code = 'ENOENT'
      return process.nextTick(() => args.pop()(err))
    }
    return process.nextTick(() => args.pop()(null, contents))
  },
  writeFile (...args) {
    tap.equal(args.length, 3)
    if (fsErr.writeFile)
      return process.nextTick(() => args.pop()(fsErr.writeFile))
    fileContents[args[0]] = args[1]
    return process.nextTick(() => args.pop()())
  }
}
const dlt = tap.mock('../src/download/dltracker.js', {
  'graceful-fs': mockGracefulFS
  // NOTE: reconstruct-map inherits use of mockGracefulFS by this mock
})

const emptyArgs = [ undefined, null, '' ]
const notStrings = [ true, 42, { type: 'url' }, ['url'], () => 'url' ]
const MAPFILENAME = 'dltracker.json'
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
      url: 'https://dark.net/xip/mystery-project.tgz'
    },
    {
      url: 'https://grey.net/foo/grey-project.tar.gz'
    },
    {
      url: 'https://light.org/bar/abcdef.tar.gz'
    }
  ]
}
for (const type in goodData) {
  for (const item of goodData[type]) {
    const filenameData = { type, ...item }
    item.filename = npf.makeTarballName(filenameData)
  }
}
for (const item of goodData.git)
  item.repo = npf.parse(item.filename).repo
for (const item of goodData.url)
  item.storedUrl = npf.parse(item.filename).url

tap.test('create() misuse', t1 => {
  for (const item of [ true, 42, {}, function(){} ])
    t1.rejects(() => dlt.create(item), TypeError) // path arg

  for (const item of [ true, 42, 'Hello', new String('Hello'), function(){} ])
    t1.rejects(() => dlt.create('dummyDir', item), TypeError) // opts arg

  for (const item of [ true, 42, 'Hello', function(){} ])
    t1.rejects(() => dlt.create('dummyDir', { log: item }), TypeError) // log option

  const testLogger = {}

  for (const item of [ 'error', 'warn', 'info', 'verbose' ]) {
    t1.rejects(
      dlt.create('dummyDir', { log: testLogger }),
      `logger must have a '${item}' method`
    )
    testLogger[item] = {}
    t1.rejects(
      dlt.create('dummyDir', { log: testLogger }),
      `logger '${item}' property is not a function`
    )
    testLogger[item] = function() {}
  }
  t1.end()
})

tap.test('create() error cases', t1 => {
  const where = 'test/dummy0'
  const absWhere = path.resolve(where)
  // Here we don't set fsStats[absWhere], and let our mock lstat manage the
  // ENOENT case:
  t1.rejects(
    dlt.create('test/dummyDir'),
    { code: 'ENOENT' },  'Given path does not exist'
  )
  .then(() => {
    // Then we set up mock existence of the path
    fsStats[absWhere] = {
      isDirectory: () => false
    }
    return t1.rejects(dlt.create(where), {
      message: /Given path is not a directory/,
      path: absWhere, code: 'ENOTDIR'
    }, 'Given path exists but not a directory')
  })
  .then(() => {
    fsStats[absWhere] = {
      isDirectory: () => true
    }
    fsErr.readFile = new Error('test case: unreadable dltracker.json')
    fsErr.readFile.code = 'EACCES'
    return t1.rejects(
      dlt.create(where, { log: mockLog }), { code: 'EACCES' },
      'Example of unreadable dltracker.json'
    )
    .then(() => {
      const logMsgs = mockLog.getList()
      t1.equal(logMsgs.length, 1)
      t1.same(logMsgs[0], {
        level: 'error', prefix: 'DownloadTracker',
        message: 'Unusable map file, error code EACCES'
      })
    })
    .finally(() => {
      delete fsErr.readFile
      mockLog.purge()
    })
  })
  .then(() => {
    const mapPath = path.join(absWhere, MAPFILENAME)
    fileContents[mapPath] = 'Not valid JSON'
    return t1.rejects(
      dlt.create(where, { log: mockLog }), SyntaxError,
      'Example of error parsing dltracker.json'
    )
    .then(() => {
      const logMsgs = mockLog.getList()
      t1.equal(logMsgs.length, 2)
      t1.same(logMsgs[0], {
        level: 'error', prefix: 'DownloadTracker',
        message: 'Failed to parse map file'
      })
      t1.same(logMsgs[1], {
        level: 'error', prefix: 'DownloadTracker',
        message: 'Unusable map file, error code undefined'
      })
    })
    .finally(() => {
      delete fileContents[mapPath]
      mockLog.purge()
    })
  })
  .finally(() => {
    t1.end()
  })
})

tap.test('create() correct use resolves to a Download Tracker instance', t1 => {
  const where = 'test/dummy1'
  const absWhere = path.resolve(where)
  const expectedProps = {
    path: absWhere,
    audit: Function,
    add: Function,
    contains: Function,
    getData: Function,
    serialize: Function
  }
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  t1.resolveMatch(
    dlt.create(where, {}), expectedProps,
    'Has all properties of a Download Tracker (opts without logger)'
  )
  .then(() => t1.resolveMatch(
    dlt.create(where, { log: mockLog }), expectedProps,
    'Has all properties of a Download Tracker (with logger)'
  ))
  .then(() => {
    const logMsgs = mockLog.getList()
    t1.equal(logMsgs.length, 1)
    t1.same(logMsgs[0], {
      level: 'info', prefix: 'DownloadTracker',
      message: 'Could not find a map file; trying to reconstruct...'
    })
  })
  .finally(() => {
    mockLog.purge()
    t1.end()
  })
})

tap.test('dltracker.json exists; put instance through its paces', t1 => {
  const s0 = goodData.semver[0]
  const s1 = goodData.semver[1]
  const s2 = goodData.semver[2]
  const g0 = goodData.git[0]
  const g1 = goodData.git[1]
  const u0 = goodData.url[0]
  const u1 = goodData.url[1]
  const u2 = goodData.url[2]
  const testTag1 = 'next'
  const testTag2 = 'greatest'
  const testGitRef = 'v3.2.1'
  const creationTimestamp = (new Date()).toLocaleString()
  const testMap = {
    semver: {
      [s0.name]: {
        [s0.version]: { filename: s0.filename },
        [s1.version]: { filename: s1.filename }
      }
    },
    tag: {
      [s1.name]: {
        [testTag1]: { version: s1.version }
      }
    },
    git: {
      [g0.repo]: {
        [g0.commit]: { filename: g0.filename }
      }
    },
    url: {
      [u0.storedUrl]: { filename: u0.filename }
    },
    created: creationTimestamp
  }
  const where = 'test/dummy2'
  const absWhere = path.resolve(where)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  const mapPath = path.join(absWhere, MAPFILENAME)
  fileContents[mapPath] = JSON.stringify(testMap)
  let tracker = null
  dlt.create(where, { log: mockLog })
  .then(tr => tr.audit())
  .then(results => {
    // The package records that will be flagged for missing file:
    const expectedData = [
      { data: { type: 'semver', ...s0 } },
      { data: { type: 'semver', ...s1 } },
      {
        data: {
          type: 'git', repo: g0.repo, commit: g0.commit, filename: g0.filename
        }
      },
      { data: { type: 'url', spec: u0.storedUrl, filename: u0.filename } }
    ]

    t1.match(results, expectedData)
    t1.equal(mockLog.getList().length, 0)

    // Next, make all the tarballs available to lstat
    const list = [ s0, s1, g0, u0 ].map(d => d.filename)
    for (const f of list) {
      fsStats[path.join(absWhere, f)] = {
        isFile: () => true,
        size: 1001
      }
    }
    return dlt.create(where, { log: mockLog })
  })
  .then(tr => {
    tracker = tr
    mockLog.purge()

    return tracker.serialize()
  })
  .then(result => {
    t1.equal(result, false, 'Refuses to serialize when nothing changed')
    t1.same(mockLog.getList()[0], {
      level: 'verbose', prefix: 'DownloadTracker.serialize',
      message: 'Nothing new to write about'
    })
    mockLog.purge()

    return tracker.audit()
  })
  .then(results => {
    t1.same(results, [])
    t1.equal(mockLog.getList().length, 0)

    // When the package name is known, but not the spec (coverage, line 641)
    t1.equal(tracker.getData('semver', s1.name, '>' + s1.version), undefined)
    // When the package name is not recognized yet (coverage, line 649)
    t1.equal(tracker.getData('tag', s2.name, testTag2), undefined)
    mockLog.purge()

    // What we must have --------------------------------------------
    t1.equal(tracker.contains('semver', s0.name, s0.version), true)
    let pkgData = tracker.getData('semver', s0.name, s0.version)
    t1.same(pkgData, { type: 'semver', ...s0 })
    checkLogAndReset(t1, 0, 2, {
      level: 'verbose', prefix: dltLogGetPrefix,
      message: `type: semver, name: ${s0.name}, spec: ${s0.version}`
    })

    t1.equal(tracker.contains('tag', s1.name, testTag1), true)
    pkgData = tracker.getData('tag', s1.name, testTag1)
    t1.same(pkgData, { type: 'tag', ...s1, spec: testTag1 })
    checkLogAndReset(t1, 0, 2, {
      level: 'verbose', prefix: dltLogGetPrefix,
      message: `type: tag, name: ${s1.name}, spec: ${testTag1}`
    })

    t1.equal(tracker.contains('git', g0.repo, g0.commit), true)
    pkgData = tracker.getData('git', g0.repo, g0.commit)
    t1.same(pkgData, {
      type: 'git', repo: g0.repo, commit: g0.commit, filename: g0.filename
    })
    checkLogAndReset(t1, 0, 2, {
      level: 'verbose', prefix: dltLogGetPrefix,
      message: `type: git, name: ${g0.repo}, spec: ${g0.commit}`
    })

    t1.equal(tracker.contains('url', '', u0.url), true)
    pkgData = tracker.getData('url', '', u0.url)
    t1.same(pkgData, { type: 'url', spec: u0.url, filename: u0.filename })
    checkLogAndReset(t1, 0, 2, {
      level: 'verbose', prefix: dltLogGetPrefix,
      message: `type: url, name: , spec: ${u0.url}`
    })
    // Also works for a spec with the protocol stripped, because
    // that's what's stored:
    pkgData = tracker.getData('url', '', u0.storedUrl)
    t1.same(pkgData, { type: 'url', spec: u0.storedUrl, filename: u0.filename })
    checkLogAndReset(t1, 0, 1, {
      level: 'verbose', prefix: dltLogGetPrefix,
      message: `type: url, name: , spec: ${u0.storedUrl}`
    })

    // What we must not have ----------------------------------------
    t1.equal(tracker.contains('semver', s2.name, s2.version), false)
    t1.same(tracker.getData('semver', s2.name, s2.version), null)

    t1.equal(tracker.contains('tag', s1.name, testTag2), false)
    t1.same(tracker.getData('tag', s1.name, testTag2), null)

    t1.equal(tracker.contains('git', g1.repo, g1.commit), false)
    t1.same(tracker.getData('git', g1.repo, g1.commit), null)

    t1.equal(tracker.contains('url', '', u1.url), false)
    pkgData = tracker.getData('url', '', u1.url)
    t1.same(tracker.getData('url', '', u1.url), null)

    // Now we start to add what we confirmed we don't have ----------
    fsStats[path.join(absWhere, s2.filename)] = {
      isFile: () => true,
      size: 1001
    }
    return tracker.add('tag', { ...s2, spec: testTag2 })
  })
  .then(() => {
    let pkgData = tracker.getData('semver', s2.name, s2.version)
    t1.same(pkgData, { type: 'semver', ...s2 })
    pkgData = tracker.getData('tag', s2.name, testTag2)
    t1.same(pkgData, { type: 'tag', ...s2, spec: testTag2 })

    // dltracker transforms '' or 'latest' tag spec to a semver record request
    for (const tagVal of [ '', 'latest' ]) {
      pkgData = tracker.getData('tag', s2.name, tagVal)
      t1.same(pkgData, { type: 'semver', ...s2 })
    }

    // What we will expect to match in dltracker.json later:
    testMap.semver[s2.name] = {
      [s2.version]: { filename: s2.filename }
    }

    fsStats[path.join(absWhere, g1.filename)] = {
      isFile: () => true,
      size: 1001
    }
    return tracker.add('git', {
      repo: g1.repo, commit: g1.commit, filename: g1.filename,
      refs: [ testGitRef ]
    })
  })
  .then(() => {
    const expectedData = {
      type: 'git', repo: g1.repo, commit: g1.commit,
      filename: g1.filename, refs: [ testGitRef ]
    }
    t1.same(tracker.getData('git', g1.repo, g1.commit), expectedData)
    t1.same(
      tracker.getData('git', g1.repo, testGitRef),
      { ...expectedData, spec: testGitRef }
    )
    // What we will expect to match in dltracker.json later:
    // (g1.repo is same as g0.repo)
    testMap.git[g1.repo][g1.commit] = {
      filename: g1.filename, refs: [ testGitRef ]
    }
    testMap.git[g1.repo][testGitRef] = { commit: g1.commit }

    fsStats[path.join(absWhere, u1.filename)] = {
      isFile: () => true, size: 1001
    }
    fsStats[path.join(absWhere, u2.filename)] = {
      isFile: () => true, size: 1001
    }
    return tracker.add('url', { spec: u1.url, filename: u1.filename })
    // We must also be able to add a record of type 'url' by a spec
    // without a protocol prefix:
    .then(() => tracker.add('url', { spec: u2.storedUrl, filename: u2.filename }))
    .then(() => tracker.audit())
  })
  .then(results => {
    t1.same(results, [])

    let pkgData = tracker.getData('url', '', u1.url)
    t1.same(pkgData, { type: 'url', spec: u1.url, filename: u1.filename })
    pkgData = tracker.getData('url', '', u2.url)
    t1.same(pkgData, { type: 'url', spec: u2.url, filename: u2.filename })
    // What we will expect to match in dltracker.json later:
    testMap.url[u1.storedUrl] = { filename: u1.filename }
    testMap.url[u2.storedUrl] = { filename: u2.filename }
    mockLog.purge()

    // Serialize() --------------------------------------------------
    // Temporarily make writeFile fail (for coverage);
    fsErr.writeFile = new Error('Mock error for serialize() test')
    fsErr.writeFile.code = 'EACCES'
    return tracker.serialize()
    .then(() => {
      throw new Error('serialize() should not succeed here!')
    })
    .catch(err => {
      t1.equal(err.code, 'EACCES')
      const logPrefix = 'DownloadTracker.serialize'
      t1.same(mockLog.getList(), [
        {
          level: 'verbose', prefix: logPrefix, message: 'writing to ' + mapPath
        },
        {
          level: 'warn', prefix: logPrefix, message: 'Failed to write map file'
        }
      ])
      mockLog.purge()

      // Remove the obstacle and try again:
      delete fsErr.writeFile
      return tracker.serialize()
    })
  })
  .then(result => {
    t1.equal(result, true)
    const logRecord = { level: 'verbose', prefix: 'DownloadTracker.serialize' }
    t1.same(mockLog.getList(), [
      { ...logRecord, message: 'writing to ' + mapPath },
      { ...logRecord, message: 'Map file written successfully.' }
    ])
    const actualMap = JSON.parse(fileContents[mapPath])
    t1.match(actualMap, testMap)
    t1.match(
      actualMap.description,
      /^This file is an artifact of the command \*\*npm download\*\*\./
    )
    t1.equal(actualMap.version, 2)
    // We don't know what characters will be in the date strings of other
    // locales, and this is locale-specific, so just as long as this exists
    // and is not empty:
    t1.ok(actualMap.updated)
  })
  .finally(() => {
    mockLog.purge() // in case of unexpected rejection
    for (const filePath in fsStats) delete fsStats[filePath]
    t1.end()
  })
})

tap.test('create() given a dltracker.json with a BOM', t1 => {
  const s0 = goodData.semver[0]
  const where = 'test/dummy3'
  const absWhere = path.resolve(where)
  const mapPath = path.join(absWhere, MAPFILENAME)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  fsStats[path.join(absWhere, s0.filename)] = {
    isFile: () => true, size: 1001
  }
  fileContents[mapPath] = '\uFEFF' + JSON.stringify({
    semver: { [s0.name]: { [s0.version]: { filename: s0.filename } } }
  })
  let tracker = null
  dlt.create(where, { log: mockLog }).then(tr => {
    tracker = tr
    return tracker.audit()
  })
  .then(results => {
    t1.same(results, [])
    t1.same(
      tracker.getData('semver', s0.name, s0.version), { type: 'semver', ...s0 }
    )
  })
  .finally(() => {
    mockLog.purge() // in case of unexpected rejection
    for (const filePath in fsStats) delete fsStats[filePath]
    delete fileContents[mapPath]
    t1.end()
  })
})

tap.test('add(): handling of errors', t1 => {
  const s0 = goodData.semver[0]
  const absWhere = path.resolve()
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  let tracker
  let testErrCode = process.platform != 'win32' ? 'EACCES' : 'EPERM'
  dlt.create('', { log: mockLog })
  .then(tr => {
    tracker = tr
    return tracker.add('semver', { ...s0 })
  })
  .catch(err => {
    t1.match(err, new RegExp(`Package ${s0.filename} not found at `))

    fsStats[path.join(absWhere, s0.filename)] = {
      isFile: () => true, size: 1001
    }
    fsErr.lstat = new Error("Don't touch me.")
    fsErr.lstat.code = testErrCode
    return tracker.add('semver', { ...s0 })
  })
  .catch(err => {
    t1.equal(err.code, testErrCode)
  })
  .finally(() => {
    mockLog.purge()
    delete fsErr.lstat
    for (const filePath in fsStats) delete fsStats[filePath]
    t1.end()
  })
})

tap.test('add() tag type data with spec "latest"', t1 => {
  const s0 = goodData.semver[0]
  const expectedData = { type: 'semver', ...s0 }
  const absWhere = path.resolve()
  const tarballPath = path.join(absWhere, s0.filename)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  fsStats[tarballPath] = {
    isFile: () => true,
    size: 1001
  }
  let tracker = null
  dlt.create('', { log: mockLog })
  .then(tr => {
    tracker = tr
    return tracker.add('tag', { ...s0, spec: 'latest' })
  })
  .then(() => {
    t1.same(tracker.getData('tag', s0.name, ''), expectedData)
    t1.same(tracker.getData('tag', s0.name, 'latest'), expectedData)
  })
  .finally(() => {
    delete fsStats[tarballPath]
    t1.end()
  })
})

// Needed for coverage (implicit else of line 493)
tap.test('add() a semver record for a pre-existing name', t1 => {
  const s0 = goodData.semver[0]
  const s1 = goodData.semver[1]
  const where = 'test/dummy3'
  const absWhere = path.resolve(where)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  fsStats[path.join(absWhere, s0.filename)] = {
    isFile: () => true, size: 1001
  }
  fsStats[path.join(absWhere, s1.filename)] = {
    isFile: () => true, size: 1001
  }
  fileContents[path.join(absWhere, MAPFILENAME)] = JSON.stringify({
    semver: { [s0.name]: { [s0.version]: { filename: s0.filename } } }
  })
  let tracker = null
  dlt.create(where, { log: mockLog }).then(tr => {
    tracker = tr
    t1.same(
      tracker.getData('semver', s0.name, '*'), { type: 'semver', ...s0 }
    )
    return tracker.add('semver', { ...s1 })
  })
  .then(() => {
    t1.same(
      tracker.getData('semver', s0.name, '*'), { type: 'semver', ...s1 }
    )
    t1.same(
      tracker.getData('semver', s0.name, s0.version), { type: 'semver', ...s0 },
      'Existing data not overwritten by add() of same name, different version'
    )
  })
  .finally(() => {
    mockLog.purge() // in case of unexpected rejection
    for (const filePath in fsStats) delete fsStats[filePath]
    t1.end()
  })
})

tap.test('add() a tag record for a pre-existing semver section record', t1 => {
  const s0 = goodData.semver[0]
  const s1 = goodData.semver[1]
  const where = 'test/dummy4'
  const absWhere = path.resolve(where)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  fsStats[path.join(absWhere, s0.filename)] = {
    isFile: () => true, size: 1001
  }
  fileContents[path.join(absWhere, MAPFILENAME)] = JSON.stringify({
    semver: { [s0.name]: { [s0.version]: { filename: s0.filename } } }
  })
  let tracker = null
  dlt.create(where, { log: mockLog }).then(tr => {
    tracker = tr
    return tracker.add('tag', { ...s0, spec: 'next' })
  })
  .then(() => {
    t1.same(tracker.getData('tag', s0.name, 'next'), {
      type: 'tag', ...s0, spec: 'next'
    })

    // Now another tag record for the same name but different tag
    fsStats[path.join(absWhere, s1.filename)] = {
      isFile: () => true, size: 1001
    }
    return tracker.add('tag', { ...s1, spec: 'unstable' })
  })
  .then(() => {
    t1.same(tracker.getData('tag', s1.name, 'unstable'), {
      type: 'tag', ...s1, spec: 'unstable'
    })
  })
  .finally(() => {
    mockLog.purge() // in case of unexpected rejection
    for (const filePath in fsStats) delete fsStats[filePath]
    t1.end()
  })
})

tap.test('serialize() a new dltracker.json', t1 => {
  const s0 = goodData.semver[0]
  const testData = { ...s0, extra: '!@#$%^&*()_+' }
  const expectedData = {
    semver: {
      [testData.name]: {
        [testData.version]: {
          extra: testData.extra,
          filename: testData.filename
        }
      }
    },
    created: /^.+$/,
    description: /^.+$/,
    version: 2
  }
  const absWhere = path.resolve()
  const mapFilePath = path.join(absWhere, MAPFILENAME)
  const tarballPath = path.join(absWhere, s0.filename)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  fsStats[tarballPath] = {
    isFile: () => true,
    size: 1001
  }
  dlt.create('', { log: mockLog })
  .then(tracker => {
    return tracker.add('semver', testData )
    .then(() => tracker.serialize())
  })
  .then(() => {
    const mapData = JSON.parse(fileContents[mapFilePath])
    t1.match(mapData, expectedData)
  })
  .finally(() => {
    for (const filepath in fsStats) delete fsStats[filepath]
    delete fileContents[mapFilePath]
    mockLog.purge()
    t1.end()
  })
})

tap.test('add() misuse', t1 => {
  const notObjects = [ true, 42, 'green', () => {} ]
  const where = 'test/dummy9'
  const absWhere = path.resolve(where)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  let tracker = null
  dlt.create(where, { log: mockLog }).then(tr => {
    tracker = tr

    t1.rejects(tracker.add())
    for (const typeArg of emptyArgs)
      t1.rejects(
        tracker.add(typeArg, {}), new SyntaxError('package type required')
      )
    for (const typeArg of notStrings)
      t1.rejects(
        tracker.add(typeArg, {}),
        new TypeError('package type must be given as a string')
      )
    for (const typeArg of [ 'semver', 'tag', 'git', 'url' ]) {
      for (const dataArg of [ undefined, null ])
        t1.rejects(
          tracker.add(typeArg, dataArg),
          new SyntaxError('package metadata required')
        )
      for (const dataArg of notObjects)
        t1.rejects(
          tracker.add(typeArg, dataArg),
          new TypeError('package metadata must be an object')
        )
      t1.rejects(
        tracker.add(typeArg, {}),
        new SyntaxError('package metadata must include a filename')
      )
      for (const filename of notStrings)
        t1.rejects(
          tracker.add(typeArg, { filename }),
          new TypeError('filename must be a string')
        )
    }

    const tagTestSrcData = {
      spec: '^1', name: 'dummy', version: '1.2.3',
      filename: 'dummy-1.2.3.tar.gz'
    }
    // All the necessary data for a semver/tag record is there, but it's
    // for nothing if the file is not present:
    t1.rejects(
      tracker.add('tag', tagTestSrcData),
      new RegExp(`Package ${tagTestSrcData.filename} not found`)
    )

    let illData = { ...tagTestSrcData }
    delete illData.spec
    t1.rejects(
      tracker.add('tag', illData),
      new SyntaxError('tag-type metadata must include tag name')
    )
    for (const spec of [ undefined, null, ...notStrings ]) {
      illData.spec = spec
      t1.rejects(
        tracker.add('tag', illData),
        new TypeError('tag name must be a string')
      )
    }
    illData.spec = '\n\t '
    t1.rejects(
      tracker.add('tag', illData),
      new SyntaxError('tag name must be a non-empty string')
    )
    for (const typeArg of [ 'semver', 'tag' ]) {
      illData = { ...tagTestSrcData }
      delete illData.name
      t1.rejects(
        tracker.add(typeArg, illData),
        new SyntaxError(`${typeArg}-type metadata must include package name`)
      )
      for (const name of [ undefined, null, ...notStrings ]) {
        illData.name = name
        t1.rejects(
          tracker.add(typeArg, illData),
          new TypeError('package name must be a string')
        )
      }
      illData.name = '\n\t '
      t1.rejects(
        tracker.add(typeArg, illData),
        new SyntaxError('package name must be a non-empty string')
      )
    }
    for (const typeArg of [ 'semver', 'tag' ]) {
      illData = { ...tagTestSrcData }
      delete illData.version
      t1.rejects(
        tracker.add(typeArg, illData),
        new SyntaxError(`${typeArg}-type metadata must include version`)
      )
      for (const ver of [ undefined, null, ...notStrings ]) {
        illData.version = ver
        t1.rejects(
          tracker.add(typeArg, illData),
          new TypeError('version spec must be a string')
        )
      }
      illData.version = '\n\t '
      t1.rejects(
        tracker.add(typeArg, illData),
        new SyntaxError('version spec must be a non-empty string')
      )
    }

    const g2 = goodData.git[2]
    const gitTestSrcData = {
      repo: g2.repo, commit: g2.commit, filename: g2.filename
    }
    illData = { ...gitTestSrcData }
    delete illData.repo
    t1.rejects(
      tracker.add('git', illData),
      new SyntaxError('git-type metadata must include repo spec')
    )
    for (const repoVal of [ undefined, null, ...notStrings ]) {
      illData.repo = repoVal
      t1.rejects(
        tracker.add('git', illData),
        new TypeError('git repo spec must be a string')
      )
    }
    illData.repo = '\n\t '
    t1.rejects(
      tracker.add('git', illData),
      new SyntaxError('git repo spec must be a non-empty string')
    )
    illData = { ...gitTestSrcData }
    delete illData.commit
    t1.rejects(
      tracker.add('git', illData),
      new SyntaxError('git-type metadata must include commit hash')
    )
    for (const commitVal of [ undefined, null, ...notStrings ]) {
      illData.commit = commitVal
      t1.rejects(
        tracker.add('git', illData),
        new TypeError('git commit must be a string')
      )
    }
    for (const commitVal of [ '', 'Not O.K.!', 'abcdefg0123456789' ]) {
      illData.commit = commitVal
      t1.rejects(
        tracker.add('git', illData),
        new SyntaxError('git commit must be a 40-character hex string')
      )
    }
    illData.commit = g2.commit
    for (const refsVal of [ true, 42, 'master', {}, () => ['master'] ]) {
      illData.refs = refsVal
      t1.rejects(
        tracker.add('git', illData),
        new TypeError('git-type metadata property \'refs\' must be an array')
      )
    }
    illData.refs = []
    t1.rejects(
      tracker.add('git', illData),
      new SyntaxError('git-type metadata refs must contain at least one tag')
    )
    for (let i = 0; i < 2; ++i) {
      for (const refVal of [ undefined, null, ...notStrings ]) {
        illData.refs[i] = refVal
        t1.rejects(
          tracker.add('git', illData),
          new TypeError('git ref must be a string')
        )
      }
      illData.refs[i] = '\n\t '
      t1.rejects(
        tracker.add('git', illData),
        new SyntaxError('git ref must be a non-empty string')
      )
      illData.refs[i] = '1.2.3'
    }

    const u0 = goodData.url[0]
    illData = { filename: u0.filename }
    t1.rejects(
      tracker.add('url', illData),
      new SyntaxError('url-type metadata must include URL')
    )
    for (const specVal of [ undefined, null, ...notStrings ]) {
      illData.spec = specVal
      t1.rejects(
        tracker.add('url', illData),
        new TypeError('URL must be a string')
      )
    }
    illData.spec = '\n\t '
    t1.rejects(
      tracker.add('url', illData),
      new SyntaxError('url spec must be a non-empty string')
    )

    t1.end()
  })
})

tap.test('getData() misuse', t1 => {
  const where = 'test/dummy10'
  const absWhere = path.resolve(where)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  let tracker = null
  dlt.create(where, { log: mockLog }).then(tr => {
    tracker = tr

    t1.throws(() => tracker.getData())
    for (const typeArg of emptyArgs)
      t1.throws(
        () => tracker.getData(typeArg, 'name', 'spec'),
        new SyntaxError('package type required')
      )
    for (const typeArg of notStrings)
      t1.throws(
        () => tracker.getData(typeArg, 'name', 'spec'),
        new TypeError('package type must be given as a string')
      )
    t1.throws(
      () => tracker.getData('gist', 'name', 'spec'),
      new RangeError('given package type "gist" unrecognized')
    )

    for (const typeArg of [ 'semver', 'tag', 'git' ]) {
      for (const nameArg of emptyArgs) {
        try { tracker.getData(typeArg, nameArg, 'spec') }
        catch (err) {
          t1.type(err, SyntaxError)
          t1.match(err, /package .*name required/)
        }
      }
      for (const nameArg of notStrings) {
        try { tracker.getData(typeArg, nameArg, 'spec') }
        catch (err) {
          t1.type(err, TypeError)
          t1.match(err, /package .*name must be given as a string/)
        }
      }
    }
    t1.throws(
      () => tracker.getData('url', 'bob', 'https://sample.com/a/b.tgz'),
      new SyntaxError('name value must be empty for type url')
    )

    for (const typeArg of [ 'semver', 'tag', 'git', 'url' ]) {
      const name = typeArg != 'url' ? 'name' : ''
      for (const specArg of [ undefined, null ]) {
        t1.throws(
          () => tracker.getData(typeArg, name, specArg),
          new SyntaxError('package spec required')
        )
      }
      for (const specArg of notStrings) {
        t1.throws(
          () => tracker.getData(typeArg, name, specArg),
          new TypeError('package spec must be given as a string')
        )
      }
    }

    t1.end()
  })
})

tap.test('git repo record variations', t1 => {
  const absWhere = path.resolve()
  const g0 = goodData.git[0]
  const g0Refs = [ '2.4.6', 'stable' ]
  const g0Rec = { repo: g0.repo, commit: g0.commit, filename: g0.filename }
  const g0RecWithRefs = { ...g0Rec, refs: g0Refs }
  const g1 = goodData.git[1]
  const g1Refs = [ '2.5.0', 'master' ]
  const g1Rec = { repo: g1.repo, commit: g1.commit, filename: g1.filename }
  const g1RecWithRefs = { ...g1Rec, refs: g1Refs }
  const g1WithMainRef = { ...g1Rec, refs: [ '2.5.0', 'main' ] }
  const g2 = goodData.git[2]
  let tracker = null
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  dlt.create(null, { log: mockLog }).then(tr => {
    tracker = tr
    fsStats[path.join(absWhere, g0.filename)] = {
      isFile: () => true,
      size: 1001
    }
    fsStats[path.join(absWhere, g1.filename)] = {
      isFile: () => true,
      size: 2001
    }
    return tracker.add('git', g0RecWithRefs)
  })
  .then(() => {
    t1.same(
      tracker.getData('git', g0.repo, '*'),
      { type: 'git', ...g0RecWithRefs },
      '"*" spec for a git repo succeeds if there is only one record'
    )
    t1.same(
      tracker.getData('git', g0.repo, ''),
      { type: 'git', ...g0RecWithRefs },
      'Empty spec for a git repo succeeds if there is only one record'
    )

    return tracker.add('git', g1Rec)
  })
  .then(() => {
    // Unspecific fetch when multiple records for a repo, but no "master" or "main"
    t1.equal(tracker.getData('git', g0.repo, '*'), undefined)
    t1.equal(tracker.getData('git', g0.repo, ''), undefined)
  })
  .then(() => {
    // Data added with same keys as before will replace the existing data
    return tracker.add('git', g1RecWithRefs)
  })
  .then(() => {
    t1.same(
      tracker.getData('git', g0.repo, '*'),
      { type: 'git', ...g1RecWithRefs },
      '"*" spec gets the record with the "master" ref'
    )
    t1.same(
      tracker.getData('git', g0.repo, ''),
      { type: 'git', ...g1RecWithRefs },
      'empty spec gets the record with the "master" ref'
    )
    t1.same(
      tracker.getData('git', g0.repo, 'semver:^2'),
      { type: 'git', spec: 'semver:^2', ...g1RecWithRefs },
      'semver range spec (^2) gets the closest match'
    )
    for (const spec of g1Refs)
      t1.same(
        tracker.getData('git', g0.repo, spec),
        { type: 'git', spec, ...g1RecWithRefs },
        `git tag spec match: ${spec}`
      )
    t1.same(
      tracker.getData('git', g0.repo, 'semver:<2.5'),
      { type: 'git', spec: 'semver:<2.5', ...g0RecWithRefs },
      'semver range spec (<2.5) gets the closest match'
    )
    for (const spec of g0Refs)
      t1.same(
        tracker.getData('git', g0.repo, spec),
        { type: 'git', spec, ...g0RecWithRefs },
        `git tag spec match: ${spec}`
      )
    t1.equal(tracker.getData('git', g0.repo, 'semver:>2'), undefined)

    // Replace the 'master' branch record with a 'main' one
    return tracker.add('git', g1WithMainRef)
  })
  .then(() => {
    t1.same(
      tracker.getData('git', g0.repo, '*'),
      { type: 'git', ...g1WithMainRef },
      '"*" spec gets the record with the "main" ref'
    )
    t1.same(
      tracker.getData('git', g0.repo, ''),
      { type: 'git', ...g1WithMainRef },
      'empty spec gets the record with the "main" ref'
    )

    mockLog.purge()
    const badSpec = '$%^&'
    t1.equal(tracker.getData('git', g0.repo, 'semver:' + badSpec), undefined)
    t1.same(mockLog.getList()[1], {
      level: 'error', prefix: 'DownloadTracker preparedData', 
      message: 'invalid semver spec: ' + badSpec
    })

    t1.equal(
      tracker.getData('git', g2.repo, g2.commit), undefined,
      'getData() for an unknown git repo spec'
    )
  })
  .finally(() => {
    mockLog.purge()
    for (const filePath in fsStats) delete fsStats[filePath]
    t1.end()
  })
})

tap.test('self-healing of map file on load', t1 => {
  const where = 'test/dummy11'
  const absWhere = path.resolve(where)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  const mapPath = path.join(absWhere, MAPFILENAME)
  const problemMap = {
    semver: null, tag: null, git: null, url: null
  }
  fileContents[mapPath] = JSON.stringify(problemMap)
  dlt.create(where, { log: mockLog })
  .then(tracker => tracker.audit())
  .then(results => {
    const logMsgs = mockLog.getList()
    for (const record of logMsgs)
      t1.match(record, {
        level: 'warn', prefix: 'DownloadTracker',
        message: /^Violation of schema in map file; discarding /
      })
    t1.same(results, [])
    mockLog.purge()
  })
  .then(() => {
    for (const type in problemMap) problemMap[type] = 'is this acceptable?'
    fileContents[mapPath] = JSON.stringify(problemMap)
    dlt.create(where, { log: mockLog })
    .then(tracker => tracker.audit())
    .then(results => {
      const logMsgs = mockLog.getList()
      for (const record of logMsgs)
        t1.match(record, {
          level: 'warn', prefix: 'DownloadTracker',
          message: /^Violation of schema in map file; discarding /
        })
      t1.same(results, [])
      mockLog.purge()
      t1.end()
    })
  })
})

tap.test('other problems revealed by audit', t1 => {
  const where = 'test/dummy12'
  const absWhere = path.resolve(where)
  fsStats[absWhere] = {
    isDirectory: () => true
  }
  const mapPath = path.join(absWhere, MAPFILENAME)
  let tracker = null

  t1.test('Self-healing of schema violation: semver records', t2 => {
    const problemMap = {
      semver: {
        pkg1: null,        // will be removed
        pkg2: 'surprise!', // will be removed
        pkg3: {},          // will be removed
        pkg4: {
          '4.0.0': null
        },
        pkg5: {
          '5.0.0': 'hello again'
        }
      }
    }
    fileContents[mapPath] = JSON.stringify(problemMap)
    dlt.create(where, { log: mockLog })
    .then(tr => tr.audit())
    .then(results => {
      const pkgNames = Object.keys(problemMap.semver)
      const logMsgs = mockLog.getList()
      for (let i = 0; i < 3; ++i) {
        const n = pkgNames[i]
        t2.same(logMsgs[i], {
          level: 'warn', prefix: 'DownloadTracker.audit',
          message: `Removing violation of schema in semver section, name '${n}'`
        })
      }
      for (const i of [ 3, 4 ]) {
        const n = pkgNames[i]
        const v = Object.keys(problemMap.semver[n])[0]
        t2.same(logMsgs[i], {
          level: 'warn', prefix: 'DownloadTracker.audit',
          message: `Replacing violation of schema at ${n}@${v}`
        })
      }
      for (let r = 0, i = 3; r < 2; ++r, ++i) {
        const n = pkgNames[i]
        const v = Object.keys(problemMap.semver[n])[0]
        t2.same(results[r].data, { name: n, version: v, type: 'semver' })
        t2.match(results[r].error, /No filename in data/)
        t2.equal(results[r].error.code, 'ENODATA')
      }

      mockLog.purge()
      t2.end()
    })
  })

  t1.test('Self-healing of schema violation: tag records', t2 => {
    const testTag = 'next'
    const problemMap = {
      tag: {
        pkg1: null,        // will be removed
        pkg2: 'surprise!', // will be removed
        pkg3: {},          // will be removed
        pkg4: {
          [testTag]: null
        },
        pkg5: {
          [testTag]: 'hello again'
        }
      }
    }
    fileContents[mapPath] = JSON.stringify(problemMap)
    dlt.create(where, { log: mockLog })
    .then(tr => tr.audit())
    .then(results => {
      const pkgNames = Object.keys(problemMap.tag)
      const logMsgs = mockLog.getList()
      for (let i = 0; i < 3; ++i) {
        const n = pkgNames[i]
        t2.same(logMsgs[i], {
          level: 'warn', prefix: 'DownloadTracker.audit',
          message: `Removing violation of schema in tag section, name '${n}'`
        })
      }
      for (const i of [ 3, 4 ]) {
        const n = pkgNames[i]
        const tag = Object.keys(problemMap.tag[n])[0]
        t2.same(logMsgs[i], {
          level: 'warn', prefix: 'DownloadTracker.audit',
          message: `Replacing violation of schema at ${n}@${tag}`
        })
      }
      for (let r = 0, i = 3; r < 2; ++r, ++i) {
        const n = pkgNames[i]
        t2.same(results[r].data, {
          name: n, spec: testTag, version: undefined, type: 'tag'
        })
        t2.match(results[r].error, /Version missing from tag record/)
        t2.equal(results[r].error.code, 'ENODATA')
      }

      mockLog.purge()
      t2.end()
    })
  })

  t1.test('Self-healing of schema violation: git records', t2 => {
    const problemMap = {
      git: {
        repo1: null,        // will be removed
        repo2: 'surprise!', // will be removed
        repo3: {},          // will be removed
        repo4: {
          [mockCommitHash()]: null
        },
        repo5: {
          [mockCommitHash()]: 'hello again'
        }
      }
    }
    fileContents[mapPath] = JSON.stringify(problemMap)
    dlt.create(where, { log: mockLog })
    .then(tr => tr.audit())
    .then(results => {
      const repos = Object.keys(problemMap.git)
      const logMsgs = mockLog.getList()
      for (let i = 0; i < 3; ++i) {
        const n = repos[i]
        t2.same(logMsgs[i], {
          level: 'warn', prefix: 'DownloadTracker.audit',
          message: `Removing violation of schema in git section, repo '${n}'`
        })
      }
      for (const i of [ 3, 4 ]) {
        const n = repos[i]
        const c = Object.keys(problemMap.git[n])[0]
        t2.same(logMsgs[i], {
          level: 'warn', prefix: 'DownloadTracker.audit',
          message: `Replacing violation of schema at ${n}#${c}`
        })
      }
      for (let r = 0, i = 3; r < 2; ++r, ++i) {
        const n = repos[i]
        const c = Object.keys(problemMap.git[n])[0]
        t2.same(results[r].data, { repo: n, commit: c, type: 'git' })
        t2.match(results[r].error, /No data in git record/)
        t2.equal(results[r].error.code, 'ENODATA')
      }

      mockLog.purge()
      t2.end()
    })
  })

  t1.test('Self-healing of schema violation: url records', t2 => {
    const problemMap = {
      url: {
        'dark.net/suspect/scheme/pkg.tgz': null,
        'light.net/mystery/1234567.tar.gz': 'surprise!'
      }
    }
    fileContents[mapPath] = JSON.stringify(problemMap)
    dlt.create(where, { log: mockLog })
    .then(tr => tr.audit())
    .then(results => {
      const urlSpecs = Object.keys(problemMap.url)
      const logMsgs = mockLog.getList()
      for (let i = 0; i < logMsgs.length; ++i) {
        const n = urlSpecs[i]
        t2.same(logMsgs[i], {
          level: 'warn', prefix: 'DownloadTracker.audit',
          message: `Replacing violation of schema at url ${n}`
        })
        t2.same(results[i].data, { spec: n, type: 'url' })
        t2.match(results[i].error, /No filename in data/)
        t2.equal(results[i].error.code, 'ENODATA')
      }

      mockLog.purge()
      t2.end()
    })
  })

  t1.test('Problems unique to tag records', t2 => {
    const testTag = 'next'
    const tarballName = 'pkg2-1.9.99.tar.gz'
    const problemMap = {
      semver: {
        pkg2: {
          '1.9.99': { filename: tarballName }
        }
      },
      tag: {
        pkg1: {
          [testTag]: { version: '1.2.3' }
        },
        pkg2: {
          [testTag]: { version: '2.0.0' }
        }
      }
    }
    fileContents[mapPath] = JSON.stringify(problemMap)
    fsStats[path.join(absWhere, tarballName)] = {
      isFile: () => true,
      size: 3001
    }
    dlt.create(where, { log: mockLog })
    .then(tr => tr.audit())
    .then(results => {
      const pkgNames = Object.keys(problemMap.tag)
      for (let i = 0; i < 2; ++i) {
        const n = pkgNames[i]
        t2.same(results[i].data, {
          type: 'tag', name: n, spec: testTag,
          version: problemMap.tag[n][testTag].version
        })
        t2.match(results[i].error, /Orphaned npm registry tag reference/)
        t2.equal(results[i].error.code, 'EORPHANREF')
      }
      t2.same(mockLog.getList(), [])

      mockLog.purge()
      t2.end()
    })
  })

  t1.test('Problems unique to git records', t2 => {
    const problemMap = {
      git: {
        repo1: {
          [mockCommitHash()]: {}
        },
        repo2: {
          'redtag': { commit: mockCommitHash() }
        }
      }
    }
    fileContents[mapPath] = JSON.stringify(problemMap)
    dlt.create(where, { log: mockLog })
    .then(tr => tr.audit())
    .then(results => {
      const repos = Object.keys(problemMap.git)
      const repo1Data = problemMap.git[repos[0]]
      t2.equal(results.length, 2)
      t2.same(results[0].data, {
        type: 'git', repo: repos[0], commit: Object.keys(repo1Data)[0]
      })
      t2.match(results[0].error, /No data in git record/)
      t2.equal(results[0].error.code, 'ENODATA')

      const repo2Data = problemMap.git[repos[1]]
      const spec2 = Object.keys(repo2Data)[0]
      const commit2 = repo2Data[spec2].commit
      t2.same(results[1].data, {
        type: 'git', repo: repos[1], commit: commit2, spec: spec2
      })
      t2.match(results[1].error, /Orphaned git commit reference/)
      t2.equal(results[1].error.code, 'EORPHANREF')

      mockLog.purge()
      t2.end()
    })
  })

  t1.test('Problems common to all records', t2 => {
    // If we ever implement validation of the form of tarball filenames
    // in audit(), we'll have to change the entries in this array
    const tarballNames = [
      'nonexistent.tgz',
      'not-a-file.tgz',
      'emptyFile.tgz',
      'noTarballExtension'
    ]
    const testVersion = '1.0.0'
    const testCommit = mockCommitHash()
    const problemMap = {
      semver: {
        pkg1: {
          [testVersion]: { filename: tarballNames[0] }
        },
        pkg2: {
          [testVersion]: { filename: tarballNames[1] }
        },
        pkg3: {
          [testVersion]: { filename: tarballNames[2] }
        },
        pkg4: {
          [testVersion]: { filename: tarballNames[3] }
        }
      }
    }
    fileContents[mapPath] = JSON.stringify(problemMap)
    fsStats[path.join(absWhere, tarballNames[1])] = {
      isFile: () => false,
    }
    fsStats[path.join(absWhere, tarballNames[2])] = {
      isFile: () => true,
      size: 0
    }
    fsStats[path.join(absWhere, tarballNames[3])] = {
      isFile: () => true,
      size: 4001
    }
    dlt.create(where, { log: mockLog })
    .then(tr => tr.audit())
    .then(results => {
      const pkgNames = Object.keys(problemMap.semver)
      t2.equal(results.length, pkgNames.length)
      for (let i = 0; i < pkgNames.length; ++i) {
        t2.same(results[i].data, {
          type: 'semver', name: pkgNames[i], version: testVersion,
          filename: tarballNames[i]
        })
      }
      t2.equal(results[0].error.code, 'ENOENT')
      t2.match(results[1].error, /Not a regular file/)
      t2.equal(results[1].error.code, 'EFNOTREG')
      t2.match(results[2].error, /File of zero length/)
      t2.equal(results[2].error.code, 'EFZEROLEN')
      t2.match(results[3].error, /File does not have a tarball extension/)
      t2.equal(results[3].error.code, 'EFNAME')
      t2.same(mockLog.getList(), [])

      delete problemMap.semver
      // Cause equivalent problems in git records:
      problemMap.git = {
        pkg1: {
          [testCommit]: { filename: tarballNames[0] }
        },
        pkg2: {
          [testCommit]: { filename: tarballNames[1] }
        },
        pkg3: {
          [testCommit]: { filename: tarballNames[2] }
        },
        pkg4: {
          [testCommit]: { filename: tarballNames[3] }
        }
      }
      fileContents[mapPath] = JSON.stringify(problemMap)
      return dlt.create(where, { log: mockLog })
    })
    .then(tr => tr.audit())
    .then(results => {
      const repoNames = Object.keys(problemMap.git)
      t2.equal(results.length, repoNames.length)
      for (let i = 0; i < repoNames.length; ++i) {
        t2.same(results[i].data, {
          type: 'git', repo: repoNames[i], commit: testCommit,
          filename: tarballNames[i]
        })
      }
      t2.equal(results[0].error.code, 'ENOENT')
      t2.match(results[1].error, /Not a regular file/)
      t2.equal(results[1].error.code, 'EFNOTREG')
      t2.match(results[2].error, /File of zero length/)
      t2.equal(results[2].error.code, 'EFZEROLEN')
      t2.match(results[3].error, /File does not have a tarball extension/)
      t2.equal(results[3].error.code, 'EFNAME')
      t2.same(mockLog.getList(), [])

      delete problemMap.git
      // Cause equivalent problems in url records:
      problemMap.url = {
        path1: { filename: tarballNames[0] },
        path2: { filename: tarballNames[1] },
        path3: { filename: tarballNames[2] },
        path4: { filename: tarballNames[3] }
      }
      fileContents[mapPath] = JSON.stringify(problemMap)
      return dlt.create(where, { log: mockLog })
    })
    .then(tr => tr.audit())
    .then(results => {
      const urlPaths = Object.keys(problemMap.url)
      t2.equal(results.length, urlPaths.length)
      for (let i = 0; i < urlPaths.length; ++i) {
        t2.same(results[i].data, {
          type: 'url', spec: urlPaths[i], filename: tarballNames[i]
        })
      }
      t2.equal(results[0].error.code, 'ENOENT')
      t2.match(results[1].error, /Not a regular file/)
      t2.equal(results[1].error.code, 'EFNOTREG')
      t2.match(results[2].error, /File of zero length/)
      t2.equal(results[2].error.code, 'EFZEROLEN')
      t2.match(results[3].error, /File does not have a tarball extension/)
      t2.equal(results[3].error.code, 'EFNAME')
      t2.same(mockLog.getList(), [])
    })
    .finally(() => {
      mockLog.purge()
      t2.end()
    })
  })

  t1.end()
})

