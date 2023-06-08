const path = require('path')
const url = require('url')

const npa = require('npm-package-arg')
const pacote = require('pacote')
const retry = require('promise-retry')

const AltArborist = require('../offliner/alt-arborist')
const AltGitFetcher = require('./alt-git')
const dltFactory = require('./dltracker')
const npf = require('./npm-package-filename')
const gitTrackerKeys = require('./git-tracker-keys')
const lockDeps = require('./lock-deps')

function DuplicateSpecError() {}
DuplicateSpecError.prototype = Object.create(Error.prototype)

const _pacoteOpts = Symbol('download.ItemAgent._pacoteOpts')
const _processItem = Symbol('download.ItemAgent._processItem')

const checkLockfileDep = (item, cmdOpts) =>
  (item.inBundle ||
    (item.peer && cmdOpts.noPeer) ||
    (item.dev && !cmdOpts.includeDev) ||
    ((item.optional || (item.devOptional && !cmdOpts.includeDev))
      && cmdOpts.noOptional)
  ) ? false : true

class ItemAgent {
  constructor(spec, opts) {
    this.opts = opts

    this.p = npa(spec)
    // original spec is now available as this.p.raw

    this.type = dltFactory.typeMap[this.p.type]
    this.dlTracker = opts.dlTracker
    this.trackerKeys = { name: this.p.name, spec: this.p.rawSpec }
    this.result = { spec: this.p.raw }
    if (this.p.name) this.result.name = this.p.name

    this.dlData = {}
  }

  run() {
    // when p.rawSpec is '', p.type gets set to 'tag' and
    // p.fetchSpec gets set to 'latest' by npa
    if ((this.p.type === 'tag' && this.p.fetchSpec === 'latest') ||
        (this.p.type === 'range' && this.p.fetchSpec === '*')) {
      this.type = 'semver'
      if (ItemAgent.latest[this.p.name]) {
        this.result.duplicate = true
        return Promise.resolve([ this.result ])
      }
    }
    else {
      if (this.p.type === 'git') {
        try {
          const gitKeys = gitTrackerKeys(this.p)
          this.trackerKeys.name = gitKeys.repo
          this.trackerKeys.spec = gitKeys.spec
        }
        catch (err) { return Promise.reject(err) }
      }
      const pkgName = this.type != 'url' ? this.trackerKeys.name : null
      if (this.dlTracker.contains(this.type, pkgName, this.trackerKeys.spec)) {
        this.result.duplicate = true
        return Promise.resolve([ this.result ])
      }
    }

    const fetchKey1 = this.trackerKeys.name ?
      `${this.trackerKeys.name}:${this.trackerKeys.spec}` : this.trackerKeys.spec
    if (ItemAgent.inflight.has(fetchKey1)) {
      this.result.duplicate = true
      return Promise.resolve([ this.result ])
    }
    ItemAgent.inflight.add(fetchKey1)

    this.fetchKey2 = null

    return this[_processItem]()
    .then(manifest => {
      // opts.lockfile==true indicates this processing is for a dependency
      // listed in a lockfile of some kind, where the entire tree of deps
      // is iterated; therefore no dependency recursion should happen.
      if (this.opts.lockfile) return []
      const tarballPath = path.join(this.dlTracker.path, this.dlData.filename)
      return retry(tryAgain =>
        lockDeps.extract(tarballPath)
        .catch(/* istanbul ignore next */ err => {
          if (err.code === 'EFZEROLEN') return tryAgain(err)
          throw err
        }),
        { retries: 2, minTimeout: 500, maxTimeout: 2000 }
      ).then(deps => {
        return deps.length ?
          processDependencies(deps, { ...this.opts, lockfile: true })
          : processDependencies(manifest, { ...this.opts })
      })
    })
    .then(results => {
      // results include dependencies, not the package that depends on them.
      // We wait until after processing its dependency tree before we add
      // the parent package to the dlTracker, because of the meaning of the
      // act of adding: it implies that every dependency of the package has
      // already been downloaded and added.
      return retry(tryAgain =>
        this.dlTracker.add(this.type, this.dlData)
        .catch(/* istanbul ignore next */ err => {
          if (err.code === 'EFZEROLEN') return tryAgain(err)
          throw err
        }),
        { retries: 2, minTimeout: 500, maxTimeout: 2000 }
      )
      .then(() => {
        ItemAgent.inflight.delete(this.fetchKey2)
        ItemAgent.inflight.delete(fetchKey1)
        results.push(this.result)
        return xformResult(results)
      })
    })
    .catch(err => {
      ItemAgent.inflight.delete(this.fetchKey2)
      ItemAgent.inflight.delete(fetchKey1)
      if (!(err instanceof DuplicateSpecError)) throw err
      this.result.duplicate = true
      return [ this.result ]
    })
  }

  // Must be overriden by derived classes
  /* istanbul ignore next */
  [_processItem]() {
    return Promise.reject(this.notImplementedError)
  }

  [_pacoteOpts](extra) {
    if (!extra) extra = {}
    const newOpts = Object.assign(
      { Arborist: AltArborist }, extra, this.opts.flatOpts
    )
    return newOpts
  }

  get duplicateSpecError() {
    return new DuplicateSpecError(this.p.raw)
  }

  /* istanbul ignore next */
  get notImplementedError() {
    return new Error('Not implemented')
  }

  static latest = {}
  static inflight = new Set()
}

function validateManifest_resolved(manifest, spec) {
  if (!manifest._resolved)
    throw new Error(`No _resolved value in manifest for ${spec}`)
  if (typeof manifest._resolved !== 'string')
    throw new Error(`Invalid _resolved value in manifest for ${spec}`)
  const parsed = new url.URL(manifest._resolved)
  if (parsed.protocol == 'file:')
    throw new Error(`Unable to parse meaningful data from _resolved field for ${spec}`)
}

class RegistryItemAgent extends ItemAgent {
  [_processItem]() {
    const spec = this.p.raw
    // Get the manifest first, then use that data to configure the download
    return pacote.manifest(spec, this[_pacoteOpts]())
    .then(mani => {
      validateManifest_resolved(mani, spec)

      if ((this.p.type === 'tag' && this.p.fetchSpec === 'latest') ||
          (this.p.type === 'range' && this.p.fetchSpec === '*')) {
        ItemAgent.latest[this.p.name] = mani.version
      }
      this.result.name = mani.name
      this.fetchKey2 = `${this.p.name}:${mani.version}:tarball`
      if (ItemAgent.inflight.has(this.fetchKey2) ||
          this.dlTracker.contains('semver', mani.name, mani.version)) {
        throw this.duplicateSpecError
      }
      ItemAgent.inflight.add(this.fetchKey2)

      Object.assign(this.dlData, {
        name: mani.name,
        version: mani.version,
        filename: npf.makeTarballName({
          type: 'semver', name: mani.name, version: mani.version
        }),
        _resolved: mani._resolved,
        _integrity: mani._integrity
      })

      if (this.type === 'tag') this.dlData.spec = this.p.rawSpec

      const filePath = path.join(this.dlTracker.path, this.dlData.filename)
      return pacote.tarball.file(
        spec, filePath, this[_pacoteOpts]({ resolved: this.dlData._resolved })
      )
      .then(() => mani)
    })
  }
}

class GitItemAgent extends ItemAgent {
  [_processItem]() {
    const spec = this.p.raw
    const noShrinkwrap = this.opts.cmd.noShrinkwrap
    return new AltGitFetcher(
      spec,
      this[_pacoteOpts]({ multipleRefs: true, noShrinkwrap })
    )
    .manifest().then(mani => {
      validateManifest_resolved(mani, spec)

      this.dlData._resolved = mani._resolved
      /* istanbul ignore next: exactly when we get the integrity value may be
       indeterminate - see below at pacote.tarball.file() */
      if (mani._integrity)
        this.dlData._integrity = mani._integrity

      this.result.spec = spec
      const tarballNameData = {
        type: 'git',
        commit: mani._sha
      }
      if (!this.p.hosted) this.p = npa(mani._resolved)
      if (this.p.hosted) {
        tarballNameData.domain = this.p.hosted.domain
        tarballNameData.path = this.p.hosted.path()
      }
      else {
        tarballNameData.domain = this.trackerKeys.name.replace(/\/.+$/, '')
        tarballNameData.path = this.trackerKeys.name.replace(/^[^/]+\//, '')
      }
      this.fetchKey2 = npf.makeTarballName(tarballNameData)
      const repoV2 = tarballNameData.domain + '/' + tarballNameData.path

      if (ItemAgent.inflight.has(this.fetchKey2) ||
          this.dlTracker.contains('git', repoV2, mani._sha)) {
        throw this.duplicateSpecError
      }
      ItemAgent.inflight.add(this.fetchKey2)

      Object.assign(this.dlData, {
        filename: this.fetchKey2,
        repo: repoV2,
        commit: mani._sha
      })
      if (mani._allRefs && mani._allRefs.length)
        this.dlData.refs = mani._allRefs

      const filePath = path.join(this.dlTracker.path, this.dlData.filename)
      // Note: here spec == `${name}@${mani.from}`
      return pacote.tarball.file(
        mani._from,
        filePath,
        this[_pacoteOpts]({
          resolved: this.dlData._resolved,
          integrity: this.dlData._integrity
        })
      )
      .then(res => {
        /* istanbul ignore else */
        if (res.integrity) this.dlData._integrity = res.integrity
        return mani
      })
    })
  }
}

class UrlItemAgent extends ItemAgent {
  [_processItem]() {
    const spec = this.p.raw
    return pacote.manifest(spec, this[_pacoteOpts]())
    .then(mani => {
      validateManifest_resolved(mani, spec)

      // If the resolved URL is the same as the requested spec,
      // it would be redundant in the dltracker data
      if (mani._resolved != spec)
        this.dlData._resolved = mani._resolved
      // The following note is from testing v6:
      // TODO: _integrity seems to cause us trouble when we pass it to pacote.tarball.toFile.
      // If it persists in causing trouble, there's no point in saving it in the data.
      //if (mani._integrity) this.dlData._integrity = mani._integrity

      this.result.spec = this.dlData.spec = spec
      this.dlData.filename = npf.makeTarballName({
        type: 'url', url: mani._resolved
      })

      this.fetchKey2 = this.dlData.filename
      if (ItemAgent.inflight.has(this.fetchKey2) ||
          this.dlTracker.contains('url', null, spec)) {
        throw this.duplicateSpecError
      }
      ItemAgent.inflight.add(this.fetchKey2)

      const filePath = path.join(this.dlTracker.path, this.dlData.filename)
      //if (this.dlData._integrity) opts.integrity = this.dlData._integrity
      return pacote.tarball.file(
        spec, filePath, this[_pacoteOpts]({ resolved: this.dlData._resolved || spec })
      )
      .then(() => mani)
    })
  }
}

const handleItem = (spec, opts) => {
  let parsed = npa(spec)
  if (parsed.type == 'alias') {
    parsed = parsed.subSpec
  }
  const dlType = dltFactory.typeMap[parsed.type]
  let agent
  switch (dlType) {
    case 'git':
      agent = new GitItemAgent(parsed, opts)
      break
    case 'semver':
    case 'tag':
      agent = new RegistryItemAgent(parsed, opts)
      break
    case 'url':
      agent = new UrlItemAgent(parsed, opts)
      break
  }
  return agent ? agent.run() :
    Promise.reject(new Error('Unhandled spec type: ' + parsed.type))
}

// Tame those nested arrays
function xformResult(res) {
  return res.reduce((acc, val) => acc.concat(val), [])
}

function getOperations(depList, opts) {
  if (depList === undefined || depList === null)
    throw new SyntaxError('Dependency list required')
  if (!Array.isArray(depList))
    throw new TypeError('Dependency list must be an Array')
  if (opts === undefined || opts === null)
    throw new SyntaxError('Options object required')
  if (typeof opts !== 'object')
    throw new TypeError('Options must be given as an object')
  if (!('dlTracker' in opts && 'flatOpts' in opts && 'cmd' in opts))
    throw new SyntaxError('Required in opts: dlTracker, flatOpts, and cmd')

  const operations = []

  if (depList.length) {
    if (typeof depList[0] === 'string') {
      // This block is strictly for a list of specs given on command line.
      // Note there is no catch to distinguish optional dep fetch failures.
      for (const item of depList) {
        if (typeof item !== 'string') {
          operations.push(Promise.reject(new TypeError(
            `Item of type ${typeof item} inconsistent with first item of list`
          )))
        }
        else operations.push(handleItem(item, { ...opts }))
      }
    }
    else { // depList derived from a lockfile
      for (const item of depList) {
        if (typeof item !== 'object' ||
            !('name' in item && 'version' in item)) {
          operations.push(Promise.reject(new TypeError(
            'Expected an object with name and version properties'
          )))
          continue
        }
        if (!checkLockfileDep(item, opts.cmd)) continue
        if (item.dev && !opts.topLevel) continue
        const spec = item.name + '@' + item.version
        operations.push(
          handleItem(spec, { ...opts })
          .catch(err => {
            if (item.optional || item.devOptional) {
              return [{ spec, failedOptional: true }]
            }
            throw err
          })
        )
      }
    }
  }
  return operations
}

function processDependencies(dataSrc, opts) {
  // NOTE: As it stands, the only ways we get in here are:
  // * by the package.json handling in download.js (--package-json option),
  //   where dataSrc is a manifest;
  // * by ItemAgent.run(), which either gives a manifest, or an array of deps
  //   obtained from a lockfile
  if (Array.isArray(dataSrc)) { // dep data from a lockfile
    const operations = getOperations(dataSrc, opts)
    return Promise.all(operations)
  }
  else { // dataSrc is a manifest
    const operations = []
    const resolvedDeps = []
    const optionalSet = new Set()
    const bundleDeps =
      dataSrc.bundledDependencies || dataSrc.bundleDependencies || []
    const regDeps = dataSrc.dependencies || {}
    for (let name in regDeps) {
      if (!bundleDeps.includes(name))
        resolvedDeps.push(`${name}@${regDeps[name]}`)
    }
    if (opts.topLevel && opts.cmd.includeDev) {
      /* istanbul ignore next: when --include=dev, we don't care about the case
         of a package with no devDependencies */
      const devDeps = dataSrc.devDependencies || {}
      for (let name in devDeps) {
        if (!bundleDeps.includes(name))
          resolvedDeps.push(`${name}@${devDeps[name]}`)
      }
    }
    if (!opts.cmd.noPeer) {
      const peerDeps = dataSrc.peerDependencies || {}
      for (let name in peerDeps) {
        if (!bundleDeps.includes(name))
          resolvedDeps.push(`${name}@${peerDeps[name]}`)
      }
    }
    /* istanbul ignore else */
    if (!opts.cmd.noOptional) {
      const optDeps = dataSrc.optionalDependencies || {}
      for (let name in optDeps) {
        if (!bundleDeps.includes(name)) {
          const pkgId = `${name}@${optDeps[name]}`
          resolvedDeps.push(pkgId)
          optionalSet.add(pkgId)
        }
      }
    }
    // We don't call getOperations here because this is the only case in
    // which we have to work with optionalSet:
    for (const item of resolvedDeps) {
      operations.push(
        handleItem(item, {
          cmd: opts.cmd, dlTracker: opts.dlTracker, flatOpts: opts.flatOpts
        })
        //.then(arr => xformResult(arr)) // Verify: this is already done in handleItem
        .catch(err => {
          if (optionalSet.has(item)) {
            return [{ spec: item, failedOptional: true }]
          }
          throw err
        })
      )
    }
    return Promise.all(operations)
  }
}

module.exports = {
  getOperations,
  processDependencies,
  xformResult
}
