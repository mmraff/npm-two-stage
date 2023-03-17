const { readFile } = require('fs').promises
const path = require('path')

const npa = require('npm-package-arg')
const tap = require('tap')
const lockDeps = require('../src/download/lock-deps')

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
    // Parseable, but missing something we require in a package-lock (lockfileVersion):
    const s = JSON.stringify({
      name: "no-name", version: "1.0.0",
      dependencies: { "a": "*", "b": "1.2.3" }
    })
    t2.throws(
      () => lockDeps.fromPackageLock(s),
      'Input does not look like lock file data'
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

  t1.end()
})

tap.test('fromYarnLock', t1 => {
  t1.test('input that causes errors', t2 => {
    t2.throws(() => lockDeps.fromYarnLock(), SyntaxError)
    for (const arg of [ undefined, null, '' ])
      t2.throws(() => lockDeps.fromYarnLock(arg), SyntaxError)
    for (const arg of [ false, 42, {}, () => {} ])
      t2.throws(() => lockDeps.fromYarnLock(arg), TypeError)
    for (const arg of [ ' ', '{}', 'spec: version', 'spec:\n  version' ])
      t2.throws(
        () => lockDeps.fromYarnLock(arg),
        'invalid or corrupted yarn.lock file'
      )
    // NOTE: This did *not* cause a throw: 'spec:'

    t2.end()
  })

  t1.test('bad value in entry property does not cause an error', t2 => {
    const name = 'really-bad-invalid'
    const yarnText = [
      `"${name}":`,
      '  version "url:// not even close to a ! valid @ npm @ specifier"',
      '  resolved "this: is: also: not: valid!"',
      ''
    ].join('\n')
    const depData = []
    t2.doesNotThrow(() =>
      Object.assign(depData, lockDeps.fromYarnLock(yarnText))
    )
    t2.match(depData, [{ name, version: /^this:/ }])
    t2.end()
  })

  t1.test('correctly processes yarn.lock entries', t2 => {
    const lockPath = path.join(
      __dirname, arboristFxtsRel, 'yarn-stuff/yarn.lock'
    )
    return readFile(lockPath, { encoding: 'utf8' })
    .then(yarnText => {
      const depData = lockDeps.fromYarnLock(yarnText)
      let failMsg
      for (const item of depData) {
        if (item.version.includes('npm:')) {
          failMsg = 'alias items must be evaluated to what they reference'
        }
        else if (item.name === 'full-git-url' && !RE_HASH_SUFFIX.test(item.version)) {
          failMsg = 'git repo item version must retain commit-ish suffix'
        }
        else if (item.name === 'ghshort' && !/\/[a-f0-9]{40}$/.test(item.version)) {
          failMsg = 'remote URL item version must retain shasum hash suffix'
        }
        else if (item.name === 'remote' && RE_HASH_SUFFIX.test(item.version)) {
          failMsg = 'registry item with remote URL spec must not retain shasum hash suffix'
        }
        else if (item.name === 'symlink') {
          failMsg = "item with no 'resolved' field must not be retained"
        }
        else if (item.name === 'tarball') {
          if (!item.version.startsWith('file:')) {
            failMsg = "item with file URL spec must have version derived from 'resolved' value"
          }
          else if (RE_HASH_SUFFIX.test(item.version)) {
            failMsg = 'item with file URL spec must not retain shasum hash suffix'
          }
        }
        if (failMsg) break
      }
      if (failMsg) t2.fail(failMsg)
      else t2.pass('as expected')
    })
  })

  t1.end()
})

tap.test('extract', t1 => {
  t1.test('tarball contains npm-shrinkwrap', t2 =>
    lockDeps.extract(
      path.join(fixtures, 'skizziks/overloaded-with-lockfiles.tgz')
    )
    .then(results => {
      t2.same(results, [
        { name: 'once', version: '1.3.2' },
        { name: 'wrappy', version: '1.0.1' }
      ])
    })
  )

  t1.test('tarball contains yarn.lock, not npm-shrinkwrap', t2 =>
    lockDeps.extract(
      path.join(fixtures, 'skizziks/yarnlock-example.tgz')
    )
    .then(results => {
      t2.same(results, [
        { name: 'once', version: '1.3.2' },
        { name: 'wrappy', version: '1.0.1' }
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
console.log('readFromDir: npm-shrinkwrap case:', deps)
      t2.same(messages, [], 'Nothing logged when npm-shrinkwrap is found')
    })
  })

  t1.test('No npm-shrinkwrap, but valid package-lock', t2 => {
    const pkgLkPath = path.join(basePath, 'mkdirp-pinned')
    messages.splice(0)
    return lockDeps.readFromDir(pkgLkPath, logger)
    .then(deps => {
console.log('readFromDir: package-lock case:', deps)
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

  t1.test('No npm-shrinkwrap or package-lock, but valid yarn.lock', t2 => {
    const yarnLkPath = path.join(basePath, 'yarn-lock-mkdirp')
    messages.splice(0)
    return lockDeps.readFromDir(yarnLkPath, logger)
    .then(deps => {
console.log('readFromDir: yarn.lock case:', deps)
      const cmd = 'download'
      t2.same(
        messages, [
          {
            level: 'info', cmd,
            msg: 'Failed to read npm-shrinkwrap.json at given lockfile-dir'
          },
          {
            level: 'info', cmd, msg: 'Error code: ENOENT'
          },
          {
            level: 'info', cmd,
            msg: 'Failed to read package-lock.json at given lockfile-dir'
          },
          {
            level: 'info', cmd, msg: 'Error code: ENOENT'
          }
        ], 'Messages logged when no npm-shrinkwrap or package-lock found'
      )
    })
  })

  t1.test('No lockfiles at given path', t2 => {
    messages.splice(0)
    return lockDeps.readFromDir(fixtures, logger)
    .then(deps => {
console.log('readFromDir: no lockfiles case:', deps)
      const cmd = 'download'
      t2.same(
        messages, [
          {
            level: 'info', cmd,
            msg: 'Failed to read npm-shrinkwrap.json at given lockfile-dir'
          },
          {
            level: 'info', cmd, msg: 'Error code: ENOENT'
          },
          {
            level: 'info', cmd,
            msg: 'Failed to read package-lock.json at given lockfile-dir'
          },
          {
            level: 'info', cmd, msg: 'Error code: ENOENT'
          },
          {
            level: 'info', cmd,
            msg: 'Failed to read yarn.lock at given lockfile-dir'
          },
          {
            level: 'info', cmd, msg: 'Error code: ENOENT'
          },
          {
            level: 'warn', cmd,
            msg: 'No usable lockfile at ' + fixtures
          }
        ], 'Messages logged when no lockfile found at all'
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

  t1.end()
})
