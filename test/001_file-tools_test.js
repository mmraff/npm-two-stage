const Emitter = require('events')
const fs = require('fs')
const path = require('path')
const util = require('util')
const promisify = util.promisify
const accessAsync = promisify(fs.access)
const chmodAsync = promisify(fs.chmod)
const lstatAsync = promisify(fs.lstat)
const mkdirAsync = promisify(fs.mkdir)
const readdirAsync = promisify(fs.readdir)
const writeFileAsync = promisify(fs.writeFile)

const expect = require('chai').expect
const rimrafAsync = promisify(require('rimraf'))

const ft = require('../lib/file-tools')

const assets = {
  root: path.join(__dirname, 'n2s_fileTools'),
  get srcDir () { return path.join(this.root, 'tempSrc') },
  get destDir () { return path.join(this.root, 'tempDest') },
  get pruneTarget () { return path.join(this.root, 'prunable') }
}

const notStringArgs = [ 42, true, {}, [], function(){} ]

function getAllFilepaths(where) {
  const masterList = []
  function iterateEntries(i, list, dir) {
    if (i >= list.length) return Promise.resolve()
    const itemPath = path.join(dir, list[i])
    return lstatAsync(itemPath).then(st => {
      if (st.isDirectory())
        return readdirAsync(itemPath).then(l => iterateEntries(0, l, itemPath))
      masterList.push(itemPath) // not a directory
    })
    .then(() => iterateEntries(i+1, list, dir))
  }
  return readdirAsync(where).then(l => iterateEntries(0, l, where))
  .then(() => masterList)
}

function expectFilesRemoved(list) {
  function iterateRemovals(i) {
    if (i >= list.length) return Promise.resolve()
    const item = list[i]
    return accessAsync(item).then(() => item)
    .catch(err => {
      if (err.code != 'ENOENT') throw err
      return iterateRemovals(i+1)
    })
  }
  return iterateRemovals(0).then(foundItem => {
    if (foundItem) throw new Error(`An item was not removed: ${foundItem}`)
  })
}

function expectUnmatchedFilesExist(list, sublist) {
  function iterateFiles(i) {
    if (i >= list.length) return Promise.resolve()
    const item = list[i]
    const p = !sublist.includes(item) ? accessAsync(list[i]) : Promise.resolve()
    return p.then(() => iterateFiles(i+1))
  }
  return iterateFiles(0)
}

function dirsHaveSameContents(dir1, dir2) {

  function iterateCompareFiles(i, dObj1, dObj2) {
    if (i >= dObj1.list.length) return Promise.resolve()
    const item = dObj1.list[i]
    const path1 = path.join(dObj1.dir, item)
    const path2 = path.join(dObj2.dir, item)
    return lstatAsync(path1).then(st1 =>
      st1.isDirectory() ? compareDirs(path1, path2) :
        lstatAsync(path2).then(st2 => {
          // Remote possibility of problem for general use:
          // What if, e.g., st1.isSocket() && st2.isSocket()?
          // But this is not general use, so we should be OK...
          if (!(st1.isFile() && st2.isFile()) || (st1.size != st2.size))
            return Promise.reject()
        })
        .catch(err => {
          if (!err) err = new Error(`Not the same: ${path1}`)
          throw err
        })
    )
    .then(() => iterateCompareFiles(i+1, dObj1, dObj2))
  }

  function compareDirs(d1, d2) {
    return readdirAsync(d1).then(list1 => readdirAsync(d2).then(list2 => {
      const dirData1 = { dir: d1, list: list1 }
      const dirData2 = { dir: d2, list: list2 }
      return iterateCompareFiles(0, dirData1, dirData2)
      .then(() => iterateCompareFiles(0, dirData2, dirData1))
    }))
  }

  return compareDirs(dir1, dir2)
}

function pickNumber(low, high) {
  return Math.floor(Math.random() * (high + 1 - low)) + low
}
function zeroPrefixed(nVal, width=3) {
  return ('' + nVal).padStart(width, '0')
}

function makeDummyFile(filepath, opts) {
  if (!opts) opts = {}
  if (!opts.size) opts.size = pickNumber(128, 1024)
  const content = opts.pattern || 'This is dummy content. '
  const buf = Buffer.alloc(opts.size, content)
  return writeFileAsync(filepath, buf)
}

function makeRandomContentDirectory(where) {
  let itemCounter = 0

  function makeFiles(where, i) {
    if (i < 1) return Promise.resolve()
    const filepath = path.join(where, `item${zeroPrefixed(itemCounter++)}`)
    return makeDummyFile(filepath, { pattern: filepath })
    .then(() => makeFiles(where, i - 1))
  }

  function makeNextDir(i, where, lowNum, highNum) {
    if (i == 0) return makeFiles(where, pickNumber(1,4))
    const dirPath = path.join(where, `item${zeroPrefixed(itemCounter++)}`)
    return mkdirAsync(dirPath)
    .then(() => makeSubdirs(dirPath, lowNum - 1, highNum -1))
    .then(() => makeNextDir(i-1, where, lowNum, highNum))
  }

  function makeSubdirs(where, lowNum, highNum) {
    if (lowNum < 0) lowNum = 0
    if (highNum == 0) return makeFiles(where, pickNumber(1,4))
    const numChildDirs = pickNumber(lowNum, highNum)
    return makeNextDir(numChildDirs, where, lowNum, highNum)
  }

  return mkdirAsync(where)
  .then(() => makeSubdirs(where, 2, 4))
}

describe('file-tools submodule', function() {
  before('create temporary test assets', function(done) {
    rimrafAsync(assets.root)
    .then(() => mkdirAsync(assets.root))
    //.then(() => mkdirAsync(assets.destDir))
    .then(() => done())
    .catch(err => done(err))
  })

  after('remove temporary test assets', function(done) {
    rimrafAsync(assets.root).then(() => done())
    .catch(err => done(err))
  })

  const didNotError = new Error("There should have been an error")

  let testEmitter

  describe('setEmitter()', function() {
    it('should throw if given nothing or an empty argument', function() {
      expect(function(){ ft.setEmitter() }).to.throw(SyntaxError)
      expect(function(){ ft.setEmitter(undefined) }).to.throw(SyntaxError)
      expect(function(){ ft.setEmitter(null) }).to.throw(SyntaxError)
    })

    it('should throw if given a value that is not an Emitter', function() {
      const notEmitters = [
        true, 42, 'dummy', [], function(){}, { emit: function(){} }
      ]
      for (let i = 0; i < notEmitters.length; ++i)
        expect(function(){ ft.setEmitter(notEmitters[i]) }).to.throw(TypeError)
    })

    it('should not throw if given a valid events.Emitter', function() {
      testEmitter = new Emitter()
      expect(function(){ ft.setEmitter(testEmitter) }).to.not.throw()
    })
  })

  describe('removeFiles()', function() {
    const messages = []
    before('create temporary test assets', function(done) {
      testEmitter.on('msg', msg => messages.push(msg))
      makeRandomContentDirectory(assets.destDir)
      // TODO: walk the result dir and get list of paths, from which to choose
      // paths (make derived list), and then to verify a success
      .then(() => done())
      .catch(err => done(err))
    })

    afterEach('per-item teardown', function() {
      messages.splice(0, messages.length)
    })

    after('clean up', function(done) {
      testEmitter.removeAllListeners()
      rimrafAsync(assets.destDir).then(() => done()).catch(err => done(err))
    })

    it('should reject with a SyntaxError if not given an argument', function(done) {
      ft.removeFiles().then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return done()
      })
      .catch(err => done(err))
    })

    it('should reject with a SyntaxError if given an empty argument', function(done) {
      ft.removeFiles(undefined).then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return ft.removeFiles(null).then(() => done(didNotError))
        .catch(err => {
          expect(err).to.be.an.instanceof(SyntaxError)
          done()
        })
      })
      .catch(err => done(err))
    })

    it('should reject with a TypeError if given wrong type of argument', function(done) {
      const nonArrayArgs = [ 42, true, 'hello', {}, function(){} ]
      function iterateBadArgs(i) {
        if (i >= nonArrayArgs.length) return Promise.resolve(true)
        const arg = nonArrayArgs[i]
        return ft.removeFiles(arg).then(() => false)
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return iterateBadArgs(i+1)
        })
      }

      iterateBadArgs(0)
      .then(allRejected => allRejected ? done() : done(didNotError))
      .catch(err => done(err))
    })

    it('should reject with a TypeError if given list contains an item that is not a string', function(done) {
      function iterateBadArgs(i) {
        if (i >= notStringArgs.length) return Promise.resolve(true)
        const item = notStringArgs[i]
        return ft.removeFiles([ item ]).then(() => false)
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return iterateBadArgs(i+1)
        })
      }

      iterateBadArgs(0)
      .then(allRejected => allRejected ? done() : done(didNotError))
      .catch(err => done(err))
    })

    it('should succeed given favorable conditions, removing all specified paths and only those', function(done) {
      getAllFilepaths(assets.destDir)
      // select every other item (odd indices)
      .then(list => {
        const partial = list.filter((item, i) => i % 2)
        return ft.removeFiles(partial)
        .then(() => expectFilesRemoved(partial))
        .then(() => expectUnmatchedFilesExist(list, partial))
      })
      .then(() => done())
      .catch(err => done(err))
    })

    it('should not reject because of files that do not exist', function(done) {
      getAllFilepaths(assets.destDir)
      .then(list => {
        const noSuchFiles = [ 'noSuch1', 'noSuch2', 'noSuch3' ]
        return ft.removeFiles(noSuchFiles)
        .then(() => {
          expect(messages).to.have.lengthOf(noSuchFiles.length)
          for (let i = 0; i < messages.length; ++i)
            expect(messages[i]).to.match(/^Could not find file/)
          return expectUnmatchedFilesExist(list, noSuchFiles)
        })
      })
      .then(() => done())
      .catch(err => done(err))
    })
  })

  // Tests of prune() precede tests of graft(), because graft() calls prune()
  describe('prune()', function() {
    before('create temporary test assets', function(done) {
      makeRandomContentDirectory(assets.destDir).then(() => done())
      .catch(err => done(err))
    })

    it('should reject with a SyntaxError if not given an argument', function(done) {
      ft.prune().then(() => done(didNotError))
      .catch(err => {
        expect(err).to.be.an.instanceof(SyntaxError)
        return done()
      })
      .catch(err => done(err))
    })

    it('should reject with a SyntaxError if given an empty argument', function(done) {
      const emptyArgs = [ undefined, null, '' ]
      function iterateEmptyArgs(i) {
        if (i >= emptyArgs.length) return Promise.resolve(true)
        const arg = emptyArgs[i]
        return ft.prune(arg).then(() => false)
        .catch(err => {
          expect(err).to.be.an.instanceof(SyntaxError)
          return iterateEmptyArgs(i+1)
        })
      }
      iterateEmptyArgs(0)
      .then(allRejected => allRejected ? done() : done(didNotError))
      .catch(err => done(err))
    })

    it('should reject with a TypeError if given wrong type of argument', function(done) {
      function iterateBadArgs(i) {
        if (i >= notStringArgs.length) return Promise.resolve(true)
        const arg = notStringArgs[i]
        return ft.prune(arg).then(() => false)
        .catch(err => {
          expect(err).to.be.an.instanceof(TypeError)
          return iterateBadArgs(i+1)
        })
      }

      iterateBadArgs(0)
      .then(allRejected => allRejected ? done() : done(didNotError))
      .catch(err => done(err))
    })

    it('should reject for non-existent target directory', function(done) {
      const fakeTgtName = 'NO_SUCH_TARGET'
      const noSuchPath = path.join(assets.root, fakeTgtName)
      ft.prune(noSuchPath).then(() => done(didNotError))
      .catch(err => {
        expect(err.code).to.equal('ENOENT')
        done()
      })
      .catch(err => done(err))
    })

    if (process.platform != 'win32') {
      it('should reject if given directory is unreadable', function(done) {
        // 0o200: -w-------
        chmodAsync(assets.destDir, 0o200)
        .then(() =>
          ft.prune(assets.destDir)
          .then(() =>
            fixIt(didNotError).then(err => done(err))
            .catch(err => done(err))
          )
          .catch(err => fixIt()).then(() => done())
        )
        .catch(err => done(err))

        function fixIt(err) {
          const p = err === didNotError ? // The directory got pruned
            makeRandomContentDirectory(assets.srcDir) :
            chmodAsync(assets.destDir, 0o755) // 0o755: rwxr-xr-x
          return p.then(() => err)
        }
      })
      // but apparently there's no problem with removing it if it's unwritable,
      // therefore no test for unwritable directory.
    }

    it('should succeed for existing target directory with no unfavorable conditions', function(done) {
      ft.prune(assets.destDir)
      .then(() => // Verify that assets.destDir no longer exists
        accessAsync(assets.destDir)
        .catch(err => { if (err.code != 'ENOENT') throw err })
      )
      .then(() => done())
      .catch(err => done(err))
    })
  })

  describe('graft()', function() {
    before('create temporary test assets', function(done) {
      makeRandomContentDirectory(assets.srcDir)
      .then(() => mkdirAsync(assets.destDir))
      .then(() => done())
      .catch(err => done(err))
    })

    it('should reject if not given appropriate arguments', function(done) {
      const badArgs = [ undefined, null, '' ].concat(notStringArgs)

      function iterateBadArgs(i) {
        if (i >= badArgs.length) return Promise.resolve()
        const arg = badArgs[i]
        return ft.graft(assets.srcDir, arg).then(() => false)
        .catch(err =>
          ft.graft(arg, assets.destDir).then(() => false)
          .catch(err => true)
        )
        .then(hadBothErrors => {
          if (hadBothErrors) return iterateBadArgs(i+1)
          throw didNotError
        })
      }

      ft.graft().then(() => done(didNotError))
      .catch(err =>
        ft.graft(assets.srcDir).then(() => done(didNotError))
        .catch(err =>
          iterateBadArgs(0).then(() => done())
          .catch(err => done(err))
        )
      )
    })

    it('should reject for non-existent source directory, leaving destination clean', function(done) {
      const fakeSourceName = 'NO_SUCH_SRC'
      ft.graft(path.join(assets.root, fakeSourceName), assets.destDir)
      .then(() => done(didNotError))
      .catch(err => {
        if (err.code != 'ENOENT') return done(err)
        const leftoverPath = path.join(assets.destDir, fakeSourceName)
        accessAsync(leftoverPath)
        .then(() => done(new Error(`Artifact of aborted graft: ${leftoverPath}`)))
        .catch(err => {
          if (err.code != 'ENOENT') return done(err)
          return done()
        })
      })
    })

    it('should reject for non-existent destination directory', function(done) {
      const fakeDestName = 'NO_SUCH_DEST'
      const noSuchPath = path.join(assets.root, fakeDestName)
      ft.graft(assets.srcDir, noSuchPath)
      .then(() => done(didNotError))
      .catch(err => {
        if (err.code != 'ENOENT') return done(err)
        // OK, so it's ENOENT, but make sure graft() didn't create the destination
        // after the error
        accessAsync(noSuchPath)
        .then(() => done(new Error(`Artifact of aborted graft: ${noSuchPath}`)))
        .catch(err => {
          if (err.code != 'ENOENT') return done(err)
          return done()
        })
      })
    })

    // --- Windows fs does not support Unix-style file modes.--------------
    if (process.platform != 'win32') {
      it('should reject if source directory is unreadable', function(done) {
        // 0o200: -w-------
        chmodAsync(assets.srcDir, 0o200)
        .then(() =>
          ft.graft(assets.srcDir, assets.destDir)
          .then(() =>
            fixIt(didNotError).then(err => done(err))
            .catch(err => done(err))
          )
          .catch(err => fixIt()).then(() => done())
        )
        .catch(err => done(err))

        function fixIt(err) {
          const destName = path.basename(assets.srcDir)
          const destPath = path.join(assets.destDir, destName)
          const p = err === didNotError ? // The destination got created
            rimrafAsync(destPath) :
            chmodAsync(assets.srcDir, 0o755) // 0o755: rwxr-xr-x
          return p.then(() => err)
        }
      })

      it('should reject if destination directory is inaccessible', function(done) {
        // 0o444: r--r--r--
        chmodAsync(assets.destDir, 0o444)
        .then(() =>
          ft.graft(assets.srcDir, assets.destDir)
          .then(() =>
            fixIt(didNotError).then(err => done(err))
            .catch(err => done(err))
          )
          .catch(err => fixIt()).then(() => done())
        )
        .catch(err => done(err))

        function fixIt(err) {
          const destName = path.basename(assets.srcDir)
          const destPath = path.join(assets.destDir, destName)
          const p = err === didNotError ? // The destination got created
            rimrafAsync(destPath) :
            chmodAsync(assets.destDir, 0o755) // 0o755: rwxr-xr-x
          return p.then(() => err)
        }
      })
    }
    // --- End of tests not to do on Windows ------------------------------

    it('should succeed given favorable conditions, yielding same contents as source at destination', function(done) {
      ft.graft(assets.srcDir, assets.destDir)
      .then(() => {
        const newDir = path.join(assets.destDir, path.basename(assets.srcDir))
        return dirsHaveSameContents(assets.srcDir, newDir)
      })
      .then(() => done())
      .catch(err => done(err))
    })

  })
})

