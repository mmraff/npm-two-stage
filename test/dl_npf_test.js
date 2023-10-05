const url = require('url')

const tap = require('tap')
const npf = require('../src/download/npm-package-filename')
const mockCommitHash = require('./lib/mock-commit-hash')

const goodMakeInput = {
  semver: {
    type: 'semver', name: 'dummy', version: '1.2.3'
  },
  git: {
    type: 'git', domain: 'gittar.net', path: 'gtUser/gtProject',
    commit: mockCommitHash()
  },
  url: {
    type: 'url', url: 'https://dark.net/spectre/trustworthy/package.tgz'
  }
}

function getHackedDataTester(type, prop, value) {
  return () => npf.makeTarballName({
    ...goodMakeInput[type], [prop]: value
  })
}

tap.test('makeTarballName', t1 => {
  t1.test('No data given', t2 => {
    t2.throws(() => npf.makeTarballName(), SyntaxError)
    t2.throws(() => npf.makeTarballName(null), SyntaxError)
    t2.end()
  })
  t1.test('Wrong type of argument', t2 => {
    const wrongArgs = [ true, 42, 'whatever', function(){}, new String('Hi') ]
    for (const item of wrongArgs) {
      t2.throws(() => npf.makeTarballName(item), TypeError)
    }
    t2.throws(() => npf.makeTarballName({}), SyntaxError)
    t2.throws(getHackedDataTester('semver', 'type', undefined), SyntaxError)
    t2.throws(getHackedDataTester('semver', 'type', null), SyntaxError)
    t2.throws(getHackedDataTester('semver', 'type', 42), TypeError)
    t2.throws(getHackedDataTester('semver', 'type', ''), SyntaxError)
    t2.end()
  })

  t1.test('Unknown "type" name', t2 => {
    t2.throws(() => npf.makeTarballName({ type: 'BADTYPE' }), /not recognized/)
    t2.end()
  })

  t1.test('Bad data for type: semver', t2 => {
    for (const prop of [ 'name', 'version' ]) {
      t2.throws(getHackedDataTester('semver', prop, undefined), SyntaxError)
      t2.throws(getHackedDataTester('semver', prop, null), SyntaxError)
      t2.throws(getHackedDataTester('semver', prop, 42), TypeError)
      t2.throws(getHackedDataTester('semver', prop, ''), SyntaxError)
    }
    t2.throws(
      getHackedDataTester('semver', 'version', '999'),
      /version is not valid by semver 2\.0/
    )
    t2.end()
  })

  t1.test('Bad data for type: git', t2 => {
    for (const prop of [ 'domain', 'path', 'commit' ]) {
      t2.throws(getHackedDataTester('git', prop, undefined), SyntaxError)
      t2.throws(getHackedDataTester('git', prop, null), SyntaxError)
      t2.throws(getHackedDataTester('git', prop, 42), TypeError)
      t2.throws(getHackedDataTester('git', prop, ''), SyntaxError)
    }
    t2.throws(
      getHackedDataTester('git', 'commit', '999'),
      /commit is not a valid commit hash/
    )
    t2.end()
  })

  t1.test('Bad data for type: url', t2 => {
    const data = { type: 'url' }

    t2.throws(getHackedDataTester('url', 'url', undefined), SyntaxError)
    t2.throws(getHackedDataTester('url', 'url', null), SyntaxError)
    t2.throws(getHackedDataTester('url', 'url', 42), TypeError)
    t2.throws(getHackedDataTester('url', 'url', ''), SyntaxError)

    // Variations to exhaust the possibilities of lines 182-183
    const errorPattern1 = /^Invalid URL$/
    const errorPattern2 = /value given for url does not look usable/
    data.url = 'www' // no protocol, no slashes, no host
    t2.throws(() => npf.makeTarballName(data), errorPattern1)
    data.url = 'https:' // no slashes, no host, no path
    t2.throws(() => npf.makeTarballName(data), errorPattern1)
    data.url = 'https://' // no host, no path
    t2.throws(() => npf.makeTarballName(data), errorPattern1)
    data.url = 'https:///' // no host
    t2.throws(() => npf.makeTarballName(data), errorPattern1)
    data.url = 'https:www' // no slashes, no host
    t2.throws(() => npf.makeTarballName(data), errorPattern2)
    data.url = 'https://www/' // path evaluates to '/'
    t2.throws(() => npf.makeTarballName(data), errorPattern2)
    data.url = 'https://www' // path evaluates to '/', and href !== data.url
    t2.throws(() => npf.makeTarballName(data), errorPattern2)
    t2.end()
  })

  t1.test('for good data of type: semver', t2 => {
    const data = goodMakeInput.semver
    const result = npf.makeTarballName(data)
    const rawExpected = data.name + '-' + data.version + '.tar.gz'
    t2.equal(result, encodeURIComponent(rawExpected))
    t2.end()
  })

  t1.test('for version-ambiguous data of type: semver', t2 => {
    const data = { ...goodMakeInput.semver, name: 'count-0.1.2' }
    const result = npf.makeTarballName(data)
    const rawExpected = data.name + '%' + data.version + '.tar.gz'
    t2.equal(result, encodeURIComponent(rawExpected))
    t2.end()
  })

  t1.test('for good data of type: git', t2 => {
    const data = goodMakeInput.git
    const result = npf.makeTarballName(data)
    const rawExpected = [
      data.domain, '/', data.path, '#', data.commit, '.tar.gz'
    ].join('')
    t2.equal(result, encodeURIComponent(rawExpected))
    t2.end()
  })

  t1.test('for good data of type: url', t2 => {
    const data = goodMakeInput.url
    const result = npf.makeTarballName(data)
    const parsed = new URL(data.url)
    const rawExpected = parsed.hostname + parsed.pathname
    t2.equal(result, encodeURIComponent(rawExpected))
    t2.end()
  })
  t1.test('for good data of type: url, no filename extension', t2 => {
    const noExtUrlPath = 'mystery.com/archive?id=12345678'
    const result = npf.makeTarballName({
      type: 'url', url: 'https://' + noExtUrlPath
    })
    t2.equal(result, encodeURIComponent(noExtUrlPath + '.tar.gz'))
    t2.end()
  })

  t1.end()
})

tap.test('parse', t1 => {
  t1.test('Undefined or null argument', t2 => {
    t2.throws(() => npf.parse(), SyntaxError)
    t2.throws(() => npf.parse(null), SyntaxError)
    t2.end()
  })
  t1.test('Wrong type of argument', t2 => {
    for (const item of [ true, 42, {}, function(){}, new String('Hi') ]) {
      t2.throws(() => npf.parse(item), TypeError)
    }
    t2.end()
  })
  t1.test('Empty string argument', t2 => {
    t2.equal(npf.parse(''), null)
    t2.end()
  })
  t1.test('Invalid characters in argument', t2 => {
    t2.equal(npf.parse('_underline-prefix-1.0.0.tar.gz'), null)
    t2.equal(npf.parse('.dotfile-1.0.1.tar.gz'), null)
    t2.equal(npf.parse('hash#char-1.0.2.tar.gz'), null)
    t2.equal(npf.parse('path/separator-1.0.3.tar.gz'), null)
    t2.end()
  })
  t1.test('Malformed URI', t2 => {
    t2.equal(npf.parse('bad-seq%FF-1.0.4.tar.gz'), null)
    t2.end()
  })
  t1.test('Unambiguous semver-2.0-conforming filename', t2 => {
    const result = npf.parse('dummy-1.2.3.tar.gz')
    t2.same(result, {
      type: 'semver', packageName: 'dummy',
      versionComparable: '1.2.3', versionNumeric: '1.2.3',
      prerelease: null, build: null, extension: '.tar.gz'
    })
    t2.end()
  })
  t1.test('Ambiguous semver-2.0-versioned filename, improperly made', t2 => {
    t2.equal(npf.parse('dummy-0.1.2-1.2.3.tar.gz'), null)
    t2.end()
  })
  t1.test('Ambiguous semver-2.0-versioned filename, properly made', t2 => {
    const result = npf.parse('dummy-0.1.2%251.2.3.tar.gz')
    t2.same(result, {
      type: 'semver', packageName: 'dummy-0.1.2',
      versionComparable: '1.2.3', versionNumeric: '1.2.3',
      prerelease: null, build: null, extension: '.tar.gz'
    })
    t2.end()
  })
  t1.test('Semver-2.0-versioned with prerelease spec', t2 => {
    const parts = {
      name: 'dummy', version: '1.0.0', prerelease: 'alpha.7.z.92'
    }
    const raw = `${parts.name}-${parts.version}-${parts.prerelease}.tar.gz`
    const result = npf.parse(encodeURIComponent(raw))
    t2.same(result, {
      type: 'semver', packageName: parts.name,
      versionComparable: parts.version + '-' + parts.prerelease,
      versionNumeric: parts.version, prerelease: parts.prerelease,
      build: null, extension: '.tar.gz'
    })
    t2.end()
  })
  t1.test('Semver-2.0-versioned with prerelease spec and build metadata', t2 => {
    const parts = {
      name: 'dummy', version: '1.0.0',
      prerelease: 'beta', build: 'exp.sha.5114f85'
    }
    const raw = [
      parts.name, '-', parts.version, '-', parts.prerelease,
      '+', parts.build, '.tar.gz'
    ].join('')
    const result = npf.parse(encodeURIComponent(raw))
    t2.same(result, {
      type: 'semver', packageName: parts.name,
      versionComparable: parts.version + '-' + parts.prerelease,
      versionNumeric: parts.version, prerelease: parts.prerelease,
      build: parts.build, extension: '.tar.gz'
    })
    t2.end()
  })
  t1.test('Git repo spec-based filename', t2 => {
    const domain = 'gittar.net'
    const repoPath = 'gtUser/gtProject'
    const commit = mockCommitHash()
    const raw = [ domain, '/', repoPath, '#', commit, '.tar.gz' ].join('')
    const result = npf.parse(encodeURIComponent(raw))
    t2.same(result, {
      type: 'git', domain, path: repoPath, repo: domain + '/' + repoPath,
      commit, extension: '.tar.gz'
    })
    t2.end()
  })
  t1.test('URL-based filename', t2 => {
    const testURL = goodMakeInput.url.url
    const parsed = new URL(testURL)
    const raw = parsed.hostname + parsed.pathname
    const result = npf.parse(encodeURIComponent(raw))
    t2.same(result, { type: 'url', url: raw })
    t2.end()
  })

  t1.end()
})

tap.test('isVersionAmbiguous', t1 => {
  const badArgs = [ true, 42, [], {}, function(){} ]

  t1.test('No argument or null name argument', t2 => {
    t2.throws(() => npf.isVersionAmbiguous(), SyntaxError)
    t2.throws(() => npf.isVersionAmbiguous(null), SyntaxError)
    t2.end()
  })
  t1.test('Non-string name argument', t2 => {
    for (const value of badArgs) {
      t2.throws(() => npf.isVersionAmbiguous(value), TypeError)
    }
    t2.end()
  })
  t1.test('Non-string version argument', t2 => {
    t2.throws(() => npf.isVersionAmbiguous('dummy', null), SyntaxError)
    for (const value of badArgs) {
      t2.throws(() => npf.isVersionAmbiguous('dummy', value), TypeError)
    }
    t2.end()
  })

  t1.test('Name argument only', t2 => {
    t2.equal(npf.isVersionAmbiguous('dummy-1.2.3'), false)
    t2.equal(npf.isVersionAmbiguous('dummy-1.2.3-9.9.9'), true)
    t2.end()
  })
  t1.test('Name argument with version argument', t2 => {
    const name1 = 'dummy'
    t2.equal(npf.isVersionAmbiguous(name1, ''), false)
    t2.equal(npf.isVersionAmbiguous(name1, 'alpha.7.z.92'), false)
    t2.equal(npf.isVersionAmbiguous(name1, '1.2.3-alpha.7.z.92'), false)
    t2.equal(npf.isVersionAmbiguous(name1, '1.2.3-9.9.9'), true)
    const name2 = 'dummy-1.2.3'
    t2.equal(npf.isVersionAmbiguous(name2, ''), false)
    t2.equal(npf.isVersionAmbiguous(name2, 'alpha.7.z.92'), false)
    t2.equal(npf.isVersionAmbiguous(name2, '9.9.9'), true)
    t2.end()
  })

  t1.end()
})

