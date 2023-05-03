const path = require('path')
const tap = require('tap')
const readTar = require('../src/download/read-from-tarball')

const fixtures = path.join(__dirname, 'fixtures/data/readTar')

tap.test('Syntax errors and Type errors', t1 => {
  const nonStrings = [ true, 42, {} ]
  const validTarball = path.join(fixtures, 'created-by-npm-pack.tgz')

  t1.test('No arguments', t2 => t2.rejects(readTar(), SyntaxError))

  for (const val of [ undefined, null, '' ])
    t1.test('1st arg is ' + val, t2 =>
      t2.rejects(readTar(val, [ 'LICENSE' ]), SyntaxError)
    )
  for (const val of nonStrings)
    t1.test('1st arg is of type ' + typeof val, t2 =>
      t2.rejects(readTar(val, [ 'LICENSE' ]), TypeError)
    )
  t1.test('No 2nd arg', t2 =>
    t2.rejects(readTar(validTarball), SyntaxError)
  )
  t1.test('2nd arg is undefined', t2 =>
    t2.rejects(readTar(validTarball, undefined), SyntaxError)
  )
  t1.test('2nd arg is null', t2 =>
    t2.rejects(readTar(validTarball, null), SyntaxError)
  )
  for (const val of [ true, 42, 'blue', {} ])
    t1.test('2nd arg is of type ' + typeof val, t2 =>
      t2.rejects(readTar(validTarball, val), TypeError)
    )
  t1.test('2nd arg is an empty array', t2 =>
    t2.rejects(readTar(validTarball, []), SyntaxError)
  )

  const lineup = [ 'a', 'b', 'c' ]
  for (let i = 0; i < lineup.length; ++i) {
    const tampered = [ ...lineup ]
    tampered[i] = ''
    t1.test('2nd arg array contains an empty string', t2 =>
      t2.rejects(readTar(validTarball, tampered), SyntaxError)
    )
  }
  const nonStringsPlus = [undefined, null ].concat(nonStrings)
  for (let i = 0; i < lineup.length; ++i) {
    const tampered = [ ...lineup ]
    for (const val of nonStringsPlus) {
      tampered[i] = val
      t1.test('2nd arg array contains bad value', t2 =>
        t2.rejects(readTar(validTarball, tampered), TypeError)
      )
    }
  }

  t1.end()
})

tap.test('Input file not found', t1 => {
  return t1.rejects(
    readTar(path.join(fixtures, 'no-such.tgz'), [ 'LICENSE' ]),
    /^ENOENT: no such file or directory/
  )
})

tap.test('Input file is empty', t1 => {
  return t1.rejects(
    readTar(path.join(fixtures, 'empty'), [ 'LICENSE' ]),
    { message: 'File of zero length', code: 'EFZEROLEN' }
  )
})

tap.test('Input file is smaller than a gzip header', t1 => {
  return t1.rejects(
    readTar(path.join(fixtures, 'head-fragment.tgz'), [ 'LICENSE' ]),
    { message: 'Not a gzipped file', code: 'EFTYPE' }
  )
})

tap.test('Input is not gzipped', t1 => {
  return t1.rejects(
    readTar(path.join(fixtures, 'bzipped.tar.bz2'), [ 'LICENSE' ]),
    { message: 'Not a gzipped file', code: 'EFTYPE' }
  )
})

tap.test('Input has a fake gzip header but is not gzipped', t1 => {
  return t1.rejects(
    readTar(path.join(fixtures, 'fake.tgz'), [ 'LICENSE' ]),
    { message: /^zlib: invalid literal\/lengths set/, code: 'Z_DATA_ERROR' }
  )
})

tap.test('Input is gzipped, but not a tarball', t1 => {
  return t1.rejects(
    readTar(path.join(fixtures, 'rand-bytes.bin.gz'), [ 'LICENSE' ]),
    { message: /^Invalid entry for a tar archive/, code: 'EFTYPE' }
  )
})

tap.test('Input is a tarball with no entries', t1 => {
  return t1.rejects(
    readTar(path.join(fixtures, 'no-entries.tar.gz'), [ 'LICENSE' ]),
    { message: /^Does not look like a tar archive/, code: 'EFTYPE' }
  )
})

tap.test('Input is an otherwise broken tarball', t1 => {
  return t1.rejects(
    readTar(path.join(fixtures, 'first-half.tgz'), [ 'LICENSE' ]),
    { message: /^zlib: unexpected end of file/, code: 'Z_BUF_ERROR' }
  )
})

tap.test('Valid tarball created by `npm pack`', t1 => {
  const targetName = 'LICENSE'
  const searchStr = 'The Artistic License 2.0'
  return readTar(path.join(fixtures, 'created-by-npm-pack.tgz'), [ targetName ])
  .then(data => {
    t1.equal(data.name, targetName)
    t1.match(data.content.toString(), searchStr)
  })
})

tap.test('Valid tarball created by real tar/gzip', t1 => {
  const targetName = 'LICENSE'
  const searchStr = 'The Artistic License 2.0'
  return readTar(path.join(fixtures, 'created-by-real-tar.tgz'), [ targetName ])
  .then(data => {
    t1.equal(data.name, targetName)
    t1.match(data.content.toString(), searchStr)
  })
})

tap.test('Tarball does not contain the single target file', t1 => {
  return t1.rejects(
    readTar(
      path.join(fixtures, 'created-by-npm-pack.tgz'), [ 'package-lock.json' ]
    ),
    { message: /^Target not found/, code: 'ENOMATCH' }
  )
})

tap.test('Tarball does not have any of multiple target files', t1 => {
  return t1.rejects(
    readTar(
      path.join(fixtures, 'created-by-npm-pack.tgz'),
      [ 'package-lock.json', 'yarn.lock' ]
    ),
    { message: /^Targets not found/, code: 'ENOMATCH' }
  )
})

tap.test('Contains not the top priority, but the single alternative', t1 => {
  const topPriority = 'npm-shrinkwrap.json'
  const acceptable = 'package-lock.json'
  return readTar(
    path.join(fixtures, 'created-by-real-tar.tgz'),
    [ topPriority, acceptable ]
  )
  .then(data => {
    t1.equal(data.name, acceptable)
    t1.ok(data.content.toString().includes('"lockfileVersion":'))
  })
})

// The next 2 tests demonstrate that the search goes on to the end if the
// top priority is not found before lower priorities on the list, but that
// we still get the content of the highest available priority.

tap.test('Lower priority found after non-topmost priority entry', t1 => {
  const bestAvailable = 'package.json'
  const acceptable = 'package-lock.json'
  return readTar(
    path.join(fixtures, 'created-by-real-tar.tgz'),
    [ 'npm-shrinkwrap.json', bestAvailable, acceptable ]
  )
  .then(data => {
    t1.equal(data.name, bestAvailable)
    t1.notOk(
      data.content.toString().includes('"lockfileVersion":'),
      'package.json does not contain a "lockfileVersion" property'
    )
  })
})

// To verify that the buffer gets written correctly when it's not the first
// to be allocated for content (start index for data chunks gets reset to 0)
tap.test('Lower priority found after non-topmost priority entry', t1 => {
  const bestAvailable = 'package-lock.json' // last entry in the tarball
  const acceptable = 'package.json'
  return readTar(
    path.join(fixtures, 'created-by-real-tar.tgz'),
    [ 'npm-shrinkwrap.json', bestAvailable, acceptable ]
  )
  .then(data => {
    const text = data.content.toString()
    t1.equal(data.name, bestAvailable)
    t1.doesNotThrow(() => JSON.parse(text))
    t1.ok(
      text.includes('"lockfileVersion":'),
      'package-lock.json contains a "lockfileVersion" property'
    )
  })
})
