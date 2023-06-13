const { readFile } = require('fs').promises
const path = require('path')

const npa = require('npm-package-arg')
const tap = require('tap')
const lockDeps = require('../src/download/lock-deps')
const mockHash = require('./lib/mock-commit-hash')

const fixtures = path.join(__dirname, 'fixtures/data')
const arboristFxtsRel = 'fixtures/arborist/fixtures'
const RE_HASH_SUFFIX = /#[a-f0-9]{40}$/

tap.test('fromPackageLock', t1 => {
  t1.test('input that causes errors', t2 => {
    t2.throws(() => lockDeps.fromPackageLock(), SyntaxError)
    for (const arg of [ undefined, null, '' ])
      t2.throws(() => lockDeps.fromPackageLock(arg), SyntaxError)
    for (const arg of [ false, 42, {}, () => {} ])
      t2.throws(() => lockDeps.fromPackageLock(arg), TypeError)

    t2.throws(
      () => lockDeps.fromPackageLock("I don't know what JSON is"),
      'Unexpected token I in JSON at position 1'
    )

    t2.end()
  })

  t1.test('no packages section, no dependencies section', t2 => {
    const s = JSON.stringify({
      name: "no-name", version: "1.0.0",
      lockfileVersion: 1
    })
    t2.same(lockDeps.fromPackageLock(s), [])
    t2.end()
  })

  t1.test('lockfileVersion 1', t2 => {
    // There is a record in this data that will trigger an exception from
    // npm-package-arg, thus covering the catch
    const lockPath = path.join(
      __dirname, arboristFxtsRel, 'install-types-sw-only/package-lock.json'
    )
    return readFile(lockPath, { encoding: 'utf8' })
    .then(content => {
      const depData = lockDeps.fromPackageLock(content)
      for (const dep of depData) {
        if (typeof dep.name !== 'string' || typeof dep.version !== 'string')
          return t2.fail('bad dependency data: ' + JSON.stringify(dep))
      }
      const gitDeps = depData.filter(dep => {
        try { return npa(dep.version).type === 'git' }
        catch (err) { return false }
      })
      for (const dep of gitDeps) {
        if (!RE_HASH_SUFFIX.test(dep.version))
          return t2.fail(
            'Failed to obtain full git repo spec for version value'
          )
      }
      const expectedNames = new Set([
        'balanced-match', 'brace-expansion', 'concat-map', 'fs.realpath',
        'glob', 'inflight', 'inherits', 'minimatch', 'path-is-absolute'
      ])
      const optDeps = depData.filter(dep => dep.optional)
      if (optDeps.length !== expectedNames.size)
        return t2.fail(
          `${optDeps.length} optional deps found; expected ${expectedNames.size}`
        )
      for (const dep of optDeps)
        if (!expectedNames.has(dep.name))
          return t2.fail('Unexpected optional dep in results: ' + dep.name)

      const devDeps = depData.filter(dep => dep.dev)
      expectedNames.clear()
      expectedNames.add('tarball').add('tarball-no-integrity')
      if (devDeps.length !== expectedNames.size)
        return t2.fail(
          `${devDeps.length} devDependencies found; expected ${expectedNames.size}`
        )
      for (const dep of devDeps)
        if (!expectedNames.has(dep.name))
          return t2.fail('Unexpected devDependency in results: ' + dep.name)

      t2.pass('dependencies data is consistent')
    })
  })

  t1.test('all deps are links on local fs', t2 => {
    // A busy alternative for this can be found in fixture pnpm
    const lockPath = path.join(
      __dirname, arboristFxtsRel, 'cli-750/package-lock.json'
    )
    return readFile(lockPath, { encoding: 'utf8' })
    .then(content => {
      const depData = lockDeps.fromPackageLock(content)
      t2.same(depData, [], 'All omitted because links are not for download')
    })
  })

  t1.test('lockfileVersion 1 deps with yarn registry "resolved"', t2 => {
    const registrySpec = "1.1.1"
    const s = JSON.stringify({
      name: "no-name", version: "1.0.0",
      lockfileVersion: 1,
      dependencies: {
        "abbrev": {
          "version": registrySpec,
          "resolved": "https://registry.yarnpkg.com/abbrev/-/abbrev-1.1.1.tgz"
        }
      }
    })
    const depData = lockDeps.fromPackageLock(s)
    t2.same(
      depData[0], { name: 'abbrev', version: registrySpec },
      'does not mistake yarn registry URL for a remote spec, translates to npm registry spec'
    )
    t2.end()
  })

  t1.test('lockfileVersion 3 deps with yarn registry "resolved"', t2 => {
    //... or lockfileVersion 2 but with dependencies section omitted.
    // Same behavior expected.
    const registrySpec = "1.1.1"
    const s = JSON.stringify({
      name: "no-name", version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            "abbrev": "^1.1.1"
          }
        },
        "node_modules/abbrev": {
          version: registrySpec,
          resolved: "https://registry.yarnpkg.com/abbrev/-/abbrev-1.1.1.tgz"
        }
      }
    })
    const depData = lockDeps.fromPackageLock(s)
    t2.same(
      depData[0], { name: 'abbrev', version: registrySpec },
      'does not mistake yarn registry URL for a remote spec, translates to npm registry spec'
    )
    t2.end()
  })

  // NOTE: git dep in lockfileVersion 1 is handled in previous test
  // 'lockfileVersion 1' - see above.

  t1.test('git dep in lockfileVersion 2', t2 => {
    const lockPath = path.join(
      __dirname, arboristFxtsRel, 'minimist-git-dep/package-lock.json'
    )
    return readFile(lockPath, { encoding: 'utf8' })
    .then(content => {
      const depData = lockDeps.fromPackageLock(content)
      const parsed = npa(depData[0].version)
      t2.ok(
        (parsed.type === 'git') && RE_HASH_SUFFIX.test(depData[0].version),
        'full git repo spec substituted for semver version value'
      )
    })
  })

  t1.test('lockfileVersion 2 dev/optional/devOptional flags', t2 => {
    const lockPath = path.join(
      __dirname, arboristFxtsRel, 'testing-rebuild-script-env-flags/package-lock.json'
    )
    return readFile(lockPath, { encoding: 'utf8' })
    .then(content => {
      const depData = lockDeps.fromPackageLock(content)
      t2.same(
        depData, [
          { name: 'devdep', version: '1.0.0', dev: true },
          { name: 'devopt', version: '1.0.0', devOptional: true },
          { name: 'opt-and-dev', version: '1.0.0', dev: true, optional: true },
          { name: 'optdep', version: '1.0.0', optional: true }
        ],
        'dev/optional/devOptional flags obtained where expected'
      )
    })
  })

  t1.test('lockfileVersion 1 peer flag', t2 => {
    const s = JSON.stringify({
      name: "no-name", version: "1.0.0",
      lockfileVersion: 1,
      dependencies: {
        "amdefine": {
          "version": "1.0.1",
          "resolved": "https://registry.npmjs.org/amdefine/-/amdefine-1.0.1.tgz",
          "integrity": "sha1-SlKCrBZHKek2Gbz9OtFR+BfOkfU=",
          "peer": true
        },
        "assert-plus": {
          "version": "1.0.0",
          "resolved": "https://registry.npmjs.org/assert-plus/-/assert-plus-1.0.0.tgz",
          "integrity": "sha1-8S4PPF13sLHN2RRpQuTpbB5N1SU=",
          "dev": true
        },
        "csstype": {
          "version": "3.0.2",
          "resolved": "https://registry.npmjs.org/csstype/-/csstype-3.0.2.tgz",
          "integrity": "sha512-ofovWglpqoqbfLNOTBNZLSbMuGrblAf1efvvArGKOZMBrIoJeu5UsAipQolkijtyQx5MtAzT/J9IHj/CEY1mJw==",
          "dev": true,
          "optional": true,
          "peer": true
        }
      }
    })
    const depData = lockDeps.fromPackageLock(s)
    t2.same(
      depData, [
        { name: 'amdefine', version: '1.0.1', peer: true },
        { name: 'assert-plus', version: '1.0.0', dev: true },
        { name: 'csstype', version: '3.0.2', dev: true, optional: true, peer: true }
      ],
      'Assortment of data does not confuse report of peer-flagged records'
    )
    t2.end()
  })

  t1.test('lockfileVersion 2 peer flag', t2 => {
    const lockPath = path.join(
      __dirname, arboristFxtsRel, 'testing-peer-dep-conflict-chain/package-lock.json'
    )
    return readFile(lockPath, { encoding: 'utf8' })
    .then(content => {
      const depData = lockDeps.fromPackageLock(content)
      const peerDeps = depData.filter(item => item.peer)
      const busyNamePrefix = '@isaacs/testing-peer-dep-conflict-chain-'
      t2.same(
        peerDeps, [
          { name: busyNamePrefix + 'b', version: '2.0.0', peer: true },
          { name: busyNamePrefix + 'c', version: '2.0.0', peer: true },
          { name: busyNamePrefix + 'd', version: '2.0.0', peer: true },
          { name: busyNamePrefix + 'e', version: '2.0.0', peer: true }
        ],
        'peer flags obtained where expected'
      )
    })
  })

  t1.test('lockfileVersion 2 inBundle flag retained', t2 => {
    const lockPath = path.join(
      __dirname, arboristFxtsRel, 'testing-bundledeps-sw/package-lock.json'
    )
    return readFile(lockPath, { encoding: 'utf8' })
    .then(content => {
      const depData = lockDeps.fromPackageLock(content)
      const bundled = depData.filter(item => item.inBundle)
      t2.same(
        bundled, [
          {
            name: '@isaacs/testing-bundledeps-a', inBundle: true,
            version: '${REGISTRY}/@isaacs/testing-bundledeps-a/-/testing-bundledeps-a-1.0.0.tgz'
          },
          {
            name: '@isaacs/testing-bundledeps-b', inBundle: true,
            version: '${REGISTRY}/@isaacs/testing-bundledeps-b/-/testing-bundledeps-b-1.0.0.tgz'
          }
        ],
        'inBundle flags obtained where expected'
      )
    })
  })

  t1.test('lockfileVersion 1 dep with alias-type spec', t2 => {
    const regName = "abbrev"
    const regSpec = "1.1.1"
    const aliasSpec = `npm:${regName}@${regSpec}`
    const s = JSON.stringify({
      name: "no-name", version: "1.0.0",
      lockfileVersion: 1,
      dependencies: {
        "mr-smith": {
          "version": aliasSpec,
          "resolved": "https://registry.npmjs.org/abbrev/-/abbrev-1.1.1.tgz"
        }
      }
    })
    const depData = lockDeps.fromPackageLock(s)
    t2.same(
      depData[0], { name: regName, version: regSpec },
      'translates alias to npm registry spec'
    )
    t2.end()
  })

  t1.test('lockfileVersion 2/3 dep with alias-type spec', t2 => {
    const regName = "abbrev"
    const regSpec = "1.1.1"
    const aliasSpec = `npm:${regName}@^${regSpec}`
    const s = JSON.stringify({
      name: "no-name", version: "1.0.0",
      lockfileVersion: 2,
      packages: {
        "": {
          dependencies: {
            "mr-smith": aliasSpec
          }
        },
        "node_modules/mr-smith": {
          name: regName,
          version: regSpec,
          resolved: "https://registry.npmjs.org/abbrev/-/abbrev-1.1.1.tgz"
        }
      }
    })
    const depData = lockDeps.fromPackageLock(s)
    t2.same(
      depData[0], { name: regName, version: regSpec },
      'translates alias to npm registry spec'
    )
    t2.end()
  })

  t1.end()
})

tap.test('fromYarnLock', t1 => {

  const yarnlockHeader = [
    '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
    '# yarn lockfile v1',
    ''
  ].join('\n')
  const yarnRegUrl = 'https://registry.yarnpkg.com'
  const dummyIntegrityLine = '  integrity sha512-nothingToSeeHere/MoveAlong=='

  t1.test('input that causes errors', t2 => {
    t2.throws(() => lockDeps.fromYarnLock(), SyntaxError)
    for (const arg of [ undefined, null, '' ])
      t2.throws(() => lockDeps.fromYarnLock(arg, {}), SyntaxError)
    for (const arg of [ true, 42, {}, () => {} ])
      t2.throws(() => lockDeps.fromYarnLock(arg, {}), TypeError)
    for (const arg of [ ' ', '{}', 'spec: version', 'spec:\n  version' ])
      t2.throws(
        () => lockDeps.fromYarnLock(arg, {}),
        'invalid or corrupted yarn.lock file'
      )
    // NOTE: This did *not* cause a throw: 'spec:'

    const dummyYarnText = [
      yarnlockHeader,
      '',
      'a@^1.0.0:',
      '  version "1.2.0"',
      `  resolved "${yarnRegUrl}/a/-/a-1.2.0.tgz#${mockHash()}"`,
      dummyIntegrityLine,
    ].join('\n')
    const expectedErrMsg = 'A package manifest is required'
    for (const arg of [ undefined, null, '' ])
      t2.throws(
        () => lockDeps.fromYarnLock(dummyYarnText, arg),
        new SyntaxError(expectedErrMsg)
      )
    for (const arg of [ true, 42, 'BOB', () => {} ])
      t2.throws(
        () => lockDeps.fromYarnLock(dummyYarnText, arg),
        new TypeError(expectedErrMsg)
      )

    t2.end()
  })

  t1.test('bad value in entry property does not cause an error', t2 => {
    const name = 'really-bad-invalid'
    const version = "url:// not even close to a ! valid @ npm @ specifier"
    const pkg = {
      name: 'root-pkg', version: '1.0.0',
      dependencies: { [name]: version }
    }
    const yarnText = [
      yarnlockHeader,
      '',
      `"${name}@${version}":`,
      `  version "${version}"`,
      '  resolved "this: is: also: not: valid!"',
      ''
    ].join('\n')
    const depData = []
    t2.doesNotThrow(() =>
      Object.assign(depData, lockDeps.fromYarnLock(yarnText, pkg))
    )
    t2.match(depData, [{ name, version: /^this:/ }])
    t2.end()
  })

  t1.test('yarn.lock entry non-error edge cases', async t2 => {
    const lockPath = path.join(__dirname, arboristFxtsRel, 'yarn-stuff')
    const opts = { encoding: 'utf8' }
    const yarnText = await readFile(path.join(lockPath, 'yarn.lock'), opts)
    const pj = await readFile(path.join(lockPath, 'package.json'), opts)
    const pkg = JSON.parse(pj)
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    let count = 0
    let failMsg
    for (const item of depData) {
      if (item.version.includes('npm:')) {
        failMsg = 'alias items must be evaluated to what they reference'
        break
      }
      switch (item.name) {
        case 'abbrev':
          ++count
          break
        case 'full-git-url':
          if (!RE_HASH_SUFFIX.test(item.version))
            failMsg = 'git repo item version must retain commit-ish suffix'
          ++count
          break
        case 'ghshort':
          if (!/\/[a-f0-9]{40}$/.test(item.version))
            failMsg = 'remote URL item version must retain shasum hash suffix'
          ++count
          break
        case 'remote':
          if (RE_HASH_SUFFIX.test(item.version))
            failMsg = 'registry item with remote URL spec must not retain shasum hash suffix'
          ++count
          break
        case 'symlink':
          failMsg = "item with no 'resolved' field must not be retained"
          ++count
          break
        case 'tarball':
          if (!item.version.startsWith('file:'))
            failMsg = "item with file URL spec must have version derived from 'resolved' value"
          else if (RE_HASH_SUFFIX.test(item.version))
            failMsg = 'item with file URL spec must not retain shasum hash suffix'
          ++count
          break
        default:
          failMsg = `item did not match expected cases: ${item.name}@${item.version}`
          ++count
      }
      if (failMsg) break
    }
    if (failMsg) t2.fail(failMsg)
    else if (count !== 6)
      t2.fail('Incorrect number of items: expected 6, actual ' + count)
    else t2.pass('as expected')
    t2.end()
  })

  t1.test('package.json missing deps (out-of-sync 1)', t2 => {
    const yarnText = [
      yarnlockHeader,
      '',
      'a@^1.2.3:',
      '  version "1.2.3"',
      `  resolved "${yarnRegUrl}/a/-/a-1.2.3.tgz#${mockHash()}"`,
      dummyIntegrityLine,
    ].join('\n')
    const pkg = {
      name: 'test-root', version: '0.0.1'
    }
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    t2.same(depData, [], 'No results, but no error')
    t2.end()
  })

  t1.test('yarn.lock and package.json out-of-sync 2', t2 => {
    const yarnText = [
      yarnlockHeader,
      '',
      'a@^1.2.3:',
      '  version "1.2.3"',
      `  resolved "${yarnRegUrl}/a/-/a-1.2.3.tgz#${mockHash()}"`,
      dummyIntegrityLine,
    ].join('\n')
    const pkg = {
      name: 'test-root', version: '0.0.1',
      dependencies: { 'b': '^9.9.9' },
      peerDependencies: { 'p': '>= 3.2.1' },
      optionalDependencies: { 'o': '~1.0.1' },
      devDependencies: { 'd': '^2.5.0' }
    }
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    t2.same(depData, [], 'No results, but no error')
    t2.end()
  })

  // Top-level devDependency has an optional dependency that has
  // no representation in the yarn.lock
  t1.test('No record for item listed as optional dep of dev dep', t2 => {
    const yarnText = [
      yarnlockHeader,
      '',
      'a@^1.2.3:',
      '  version "1.2.3"',
      `  resolved "${yarnRegUrl}/a/-/a-1.2.3.tgz#${mockHash()}"`,
      dummyIntegrityLine,
      '  optionalDependencies:',
      '    b "^9.9.9"'
    ].join('\n')
    const pkg = {
      name: 'test-root', version: '0.0.1',
      devDependencies: { 'a': '^1.2.3' }
    }
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    t2.same(
      depData, [ { name: 'a', version: '1.2.3', dev: true } ],
      'No error; only record is top-level dev dep'
    )
    t2.end()
  })

  t1.test('All packages bundled', async t2 => {
    // In this case, it doesn't matter what's in the yarn.lock, as long as
    // it's of valid form
    const yarnText = [
      yarnlockHeader,
      '',
      'a@^1.2.3:',
      '  version "1.2.3"',
      `  resolved "${yarnRegUrl}/a/-/a-1.2.3.tgz#${mockHash()}"`,
      dummyIntegrityLine,
    ].join('\n')
    // In a real package, it would be obnoxious to bundle every category of
    // dependency, especially devDependencies; but we must get coverage of
    // all possibilities
    const pkg = {
      name: 'test-root', version: '0.0.1',
      dependencies: { 'b': '^9.9.9' },
      peerDependencies: { 'p': '>= 3.2.1' },
      optionalDependencies: { 'o': '~1.0.1' },
      devDependencies: { 'd': '^2.5.0' },
      bundleDependencies: [ 'b', 'd', 'o', 'p' ]
    }
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    t2.same(depData, [], 'No results, but no error')
    t2.end()
  })

  t1.test('No regular dependencies, only devDependencies', t2 => {
    const yarnText = [
      yarnlockHeader,
      '',
      'a@^1.2.3:',
      '  version "1.2.3"',
      `  resolved "${yarnRegUrl}/a/-/a-1.2.3.tgz#${mockHash()}"`,
      dummyIntegrityLine,
    ].join('\n')
    const pkg = {
      name: 'test-root', version: '0.0.1',
      devDependencies: { 'a': '^1.2.3' }
    }
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    t2.same(depData, [
      { name: 'a', version: '1.2.3', dev: true }
    ])
    t2.end()
  })

  t1.test('Items of multiple categories with shared dependencies', async t2 => {
    const lockPath = path.join(fixtures, 'multi-types-shared-deps')
    const opts = { encoding: 'utf8' }
    const yarnText = await readFile(path.join(lockPath, 'yarn.lock'), opts)
    const pj = await readFile(path.join(lockPath, 'package.json'), opts)
    const pkg = JSON.parse(pj)
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    t2.same(depData, [
      { name: 'a', version: '0.2.6' },
      { name: 'd', version: '1.0.2', dev: true },
      { name: 'p', version: '0.4.24', peer: true },
      { name: 'pr', version: '0.2.11', peer: true },
      { name: 'o', version: '0.1.2', optional: true },
      { name: 'or', version: '0.1.1', devOptional: true },
      { name: 'b', version: '2.1.2' }
    ])
    t2.end()
  })

  t1.test('Optional dependencies everywhere', async t2 => {
    const lockPath = path.join(fixtures, 'lots-of-optional')
    const opts = { encoding: 'utf8' }
    const yarnText = await readFile(path.join(lockPath, 'yarn.lock'), opts)
    const pj = await readFile(path.join(lockPath, 'package.json'), opts)
    const pkg = JSON.parse(pj)
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    t2.same(depData, [
      { name: 'a', version: '1.0.0' },
      { name: 'ao1', version: '1.1.1', optional: true },
      { name: 'ao2', version: '1.1.2', optional: true },
      { name: 'd', version: '2.0.0', dev: true },
      { name: 'do1', version: '2.1.0', optional: true, dev: true },
      { name: 'do2', version: '2.2.11', optional: true, dev: true },
      { name: 'doo', version: '2.2.0', optional: true, dev: true },
      { name: 'o', version: '3.0.0', optional: true },
      { name: 'oo', version: '3.1.0', optional: true },
      { name: 'p', version: '4.0.0', peer: true },
      { name: 'po', version: '4.1.0', peer: true, optional: true }
    ])
    t2.end()
  })

  t1.test('Transitive deps that form cycles', async t2 => {
    const lockPath = path.join(fixtures, 'lots-of-cycles')
    const opts = { encoding: 'utf8' }
    const yarnText = await readFile(path.join(lockPath, 'yarn.lock'), opts)
    const pj = await readFile(path.join(lockPath, 'package.json'), opts)
    const pkg = JSON.parse(pj)
    const depData = lockDeps.fromYarnLock(yarnText, pkg)
    t2.same(depData, [
      { name: 'a', version: '1.0.0' },
      { name: 'ar1', version: '1.1.1' },
      { name: 'ar2', version: '1.1.2' },
      { name: 'd', version: '2.0.0', dev: true },
      { name: 'dr1', version: '2.1.0', dev: true },
      { name: 'dr2', version: '2.2.0', dev: true },
      { name: 'o', version: '3.0.0', optional: true },
      { name: 'or1', version: '3.1.0', optional: true },
      { name: 'or2', version: '3.2.0', optional: true },
      { name: 'p', version: '4.0.0', peer: true },
      { name: 'pr1', version: '4.1.0', peer: true },
      { name: 'pr2', version: '4.2.0', peer: true }
    ])
    t2.end()
  })

  t1.end()
})

tap.test('extract', t1 => {
  t1.test('not a tarball', t2 => {
    t2.rejects(
      lockDeps.extract(
        path.join(fixtures, 'readTar/bzipped.tar.bz2'), { packageLock: true }
      ),
      { message: 'Not a gzipped file', code: 'EFTYPE' }
    )
    t2.end()
  })

  t1.test('tarball contains 3 lockfiles', t2 =>
    // The lockfiles have been modified to specify different versions,
    // so that we can tell by the results which lockfile was chosen
    lockDeps.extract(
      path.join(fixtures, 'skizziks/overloaded-with-lockfiles.tgz')
    )
    .then(results => {
      t2.same(results, [
          { name: 'once', version: '1.3.2' },
          { name: 'wrappy', version: '1.0.1' }
        ],
        'npm-shrinkwrap.json is preferred'
      )
    })
  )

  t1.test('tarball contains yarn.lock, no other lockfiles', t2 =>
    lockDeps.extract(
      path.join(fixtures, 'skizziks/yarnlock-example.tgz')
    )
    .then(results => {
      t2.same(results, [
        { name: 'once', version: '1.3.2' },
        { name: 'wrappy', version: '1.0.0' }
      ])
    })
  )

  t1.test('tarball contains package-lock, not npm-shrinkwrap', t2 =>
    lockDeps.extract(
      path.join(fixtures, 'readTar/created-by-real-tar.tgz'),
      { packageLock: true }
    )
    .then(results => {
      t2.same(results, [ { name: 'abbrev', version: '1.1.1' } ])
    })
  )

  t1.test('tarball contains no lock files', t2 =>
    lockDeps.extract(
      path.join(fixtures, 'skizziks/remote1-1.0.0.tgz'),
      { packageLock: true }
    )
    .then(results => {
      t2.same(results, [], 'but that\'s OK')
    })
  )

  t1.test('tarball has yarn.lock but no package.json', t2 => {
    t2.rejects(
      lockDeps.extract(path.join(fixtures, 'skizziks/only-yarnlock.tgz')),
      { code: 'ENOPACKAGEJSON' }
    )
    t2.end()
  })

  t1.test('tarball has yarn.lock with an unparseable package.json', t2 => {
    t2.rejects(
      lockDeps.extract(
        path.join(fixtures, 'skizziks/yarnlock-mangled-pkg-json.tgz')
      ),
      { code: 'EJSONPARSE' }
    )
    t2.end()
  })

  t1.end()
})

tap.test('readFromDir', t1 => {
  t1.test('input that causes errors', t2 => {
    t2.rejects(lockDeps.readFromDir(), SyntaxError)
    for (const arg of [ undefined, null, '' ])
      t2.rejects(lockDeps.readFromDir(arg), SyntaxError)
    for (const arg of [ false, 42, {}, () => {} ])
      t2.rejects(lockDeps.readFromDir(arg), TypeError)
    t2.end()
  })

  const basePath = path.join(__dirname, arboristFxtsRel)
  const messages = []
  const logger = {
    info: (cmd, ...args) => {
      messages.push({ level: 'info', cmd, msg: args.join(' ') })
    },
    warn: (cmd, ...args) => {
      messages.push({ level: 'warn', cmd, msg: args.join(' ') })
    }
  }

  t1.test('Directory contains valid npm-shrinkwrap', t2 => {
    const shrwrPath = path.join(basePath, 'test-package-with-shrinkwrap')
    return lockDeps.readFromDir(shrwrPath, logger)
    .then(deps => {
      t2.same(messages, [], 'Nothing logged when npm-shrinkwrap is found')
    })
  })

  t1.test('No npm-shrinkwrap, but valid package-lock', t2 => {
    const pkgLkPath = path.join(basePath, 'mkdirp-pinned')
    messages.splice(0)
    return lockDeps.readFromDir(pkgLkPath, logger)
    .then(deps => {
      const cmd = 'download'
      t2.same(
        messages, [
          {
            level: 'info', cmd,
            msg: 'Failed to read npm-shrinkwrap.json at given lockfile-dir'
          },
          {
            level: 'info', cmd, msg: 'Error code: ENOENT'
          }
        ], 'Messages logged when npm-shrinkwrap is not found'
      )
    })
  })

  const msgList_NoShrwrapNoPkglock = [
    {
      level: 'info', cmd: 'download',
      msg: 'Failed to read npm-shrinkwrap.json at given lockfile-dir'
    },
    {
      level: 'info', cmd: 'download', msg: 'Error code: ENOENT'
    },
    {
      level: 'info', cmd: 'download',
      msg: 'Failed to read package-lock.json at given lockfile-dir'
    },
    {
      level: 'info', cmd: 'download', msg: 'Error code: ENOENT'
    }
  ]

  t1.test('No npm-shrinkwrap or package-lock, but valid yarn.lock', t2 => {
    const yarnLkPath = path.join(basePath, 'yarn-lock-mkdirp')
    messages.splice(0)
    return lockDeps.readFromDir(yarnLkPath, logger)
    .then(deps => {
      const cmd = 'download'
      t2.same(
        messages, msgList_NoShrwrapNoPkglock,
        'Messages logged when no npm-shrinkwrap or package-lock found'
      )
    })
  })

  t1.test('No lockfiles at given path', t2 => {
    messages.splice(0)
    return lockDeps.readFromDir(fixtures, logger)
    .then(deps => {
      const cmd = 'download'
      t2.same(
        messages, msgList_NoShrwrapNoPkglock.concat([
          {
            level: 'info', cmd,
            msg: 'Failed to read yarn.lock at given lockfile-dir'
          },
          {
            level: 'info', cmd, msg: 'Error code: ENOENT'
          },
          {
            level: 'warn', cmd,
            msg: [
              "ENOENT: no such file or directory, open '",
              path.join(fixtures, 'yarn.lock'), "'"
            ].join('')
          },
          {
            level: 'warn', cmd,
            msg: 'No usable lockfile at ' + fixtures
          }
        ]), 'Messages logged when no lockfile found at all'
      )

      // Again, without the logger (for coverage)
      messages.splice(0)
      return lockDeps.readFromDir(fixtures)
    })
    .then(deps => {
      t2.same(deps, [], 'Logger may be omitted without harm')
      t2.same(messages, [])
    })
  })

  t1.test('yarn.lock present, but no package.json', t2 => {
    const yarnLkSrc = path.join(basePath, 'yarn-lock-mkdirp/yarn.lock')
    let lockDir
    return readFile(yarnLkSrc, { encoding: 'utf8' })
    .then(content => {
      lockDir = t2.testdir({ 'yarn.lock': content })
      messages.splice(0)
      return lockDeps.readFromDir(lockDir, logger)
    })
    .then(deps => {
      const cmd = 'download'
      t2.same(deps, [])
      t2.same(
        messages, msgList_NoShrwrapNoPkglock.concat([
          {
            level: 'warn', cmd,
            msg: 'Failed to read package.json at given lockfile-dir'
          },
          {
            level: 'warn', cmd, msg: 'Error code: ENOENT'
          },
          {
            level: 'warn', cmd,
            msg: 'A package.json is required to aid in processing a yarn.lock'
          },
          {
            level: 'warn', cmd,
            msg: [
              "ENOENT: no such file or directory, open '",
              path.join(lockDir, 'package.json'), "'"
            ].join('')
          },
          {
            level: 'warn', cmd,
            msg: 'No usable lockfile at ' + lockDir
          }
        ]), 'Messages logged when yarn.lock found but no package.json'
      )
    })
  })

  t1.test('yarn.lock with invalid package.json', t2 => {
    const yarnLkSrc = path.join(basePath, 'yarn-lock-mkdirp/yarn.lock')
    let lockDir
    return readFile(yarnLkSrc, { encoding: 'utf8' })
    .then(content => {
      lockDir = t2.testdir({
        'yarn.lock': content,
        'package.json': '!@#$%^&*()'
      })
      messages.splice(0)
      return lockDeps.readFromDir(lockDir, logger)
    })
    .then(deps => {
      const cmd = 'download'
      t2.same(deps, [])
      t2.same(
        messages, msgList_NoShrwrapNoPkglock.concat([
          {
            level: 'warn', cmd,
            msg: [
              'Failed to parse package.json: ',
              'Unexpected token ! in JSON at position 0'
            ].join('')
          },
          {
            level: 'warn', cmd,
            msg: 'No usable lockfile at ' + lockDir
          }
        ]),
        'Messages logged for yarn.lock with invalid package.json'
      )
    })
  })

  t1.end()
})
