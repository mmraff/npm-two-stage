const path = require('path')
const url = require('url')

const npa = require('npm-package-arg')
const pacote = require('pacote')

const AltGitFetcher = require('./alt-git')
const dltFactory = require('./dltracker')
const npf = require('./npm-package-filename')
const gitTrackerKeys = require('./git-tracker-keys')

function DuplicateSpecError() {}
DuplicateSpecError.prototype = Object.create(Error.prototype)

const _pacoteOpts = Symbol('download.ItemAgent._pacoteOpts')
const _processItem = Symbol('download.ItemAgent._processItem')

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
      if (this.dlTracker.contains(this.type, this.trackerKeys.name, this.trackerKeys.spec)) {
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
    .then(manifest => processDependencies(manifest, this.opts))
    .then(results => {
      // results include dependencies, not the package that depends on them.
      // We wait until after processing its dependency tree before we add
      // the parent package to the dlTracker, because of the meaning of the
      // act of adding: it implies that every dependency of the package has
      // already been downloaded and added.
      return this.dlTracker.add(this.type, this.dlData)
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
    const newOpts = Object.assign({}, extra, this.opts.flatOpts)
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
        commit: mani._sha,
        refs: mani._allRefs
      })

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

function createAgent(rawSpec, opts) {
  const parsed = npa(rawSpec)
  const dlType = dltFactory.typeMap[parsed.type]
  switch (dlType) {
    case 'git': return new GitItemAgent(parsed, opts)

    case 'semver':
    case 'tag': return new RegistryItemAgent(parsed, opts)

    case 'url': return new UrlItemAgent(parsed, opts)

    default: throw new TypeError('Unknown spec type: ' + parsed.type)
  }
}

const handleItem = (spec, opts) => {
  let agent
  try { agent = createAgent(spec, opts) }
  catch (err) { return Promise.reject(err) }
  return agent.run()
}

// Tame those nested arrays
function xformResult(res) {
  return res.reduce((acc, val) => acc.concat(val), [])
}

function processDependencies(manifest, opts) {
  // opts.shrinkwrap==true indicates that this processing is for a dependency
  // listed in a shrinkwrap file, where the entire tree of dependencies is
  // iterated; therefore no dependency recursion should happen.
  if (opts.shrinkwrap)
    return Promise.resolve([])

  /*
    TODO: the following note may be true about scripts.prepare, but it's not
    true that we don't need devDependencies of non-git dependencies in all
    scripts cases: there's preinstall, install, and postinstall (see the doc
    on package-lock.json, under Configuring npm)
  */
  // IMPORTANT NOTE about scripts.prepare...
  // No need to worry about the devDependencies required for scripts.prepare,
  // because it only applies in the case of package type 'git', and it's
  // already handled by pacote when it calls pack() for the local clone of
  // the repo.
  const bundleDeps = manifest.bundledDependencies || manifest.bundleDependencies || []
  const resolvedDeps = []
  const optionalSet = new Set()
  const operations = []

  if (manifest._shrinkwrap && !opts.cmd.noShrinkwrap) {
    /*
      WARNING: shrinkwrap.dependencies is a legacy feature (lockfileVersion 1),
      maintained "in order to support switching between npm v6 and npm v7."
      So here we're relying on a legacy feature, which is safe for operating on
      packages published up to the time of npm 7 (and necessary for operating
      on those published earlier than that); *however*, "npm v7 ignores this
      section entirely if a packages section is present"... and that implies
      that it would be wise to develop an approach here that follows suit, even
      if only for ease of migration to the next version, npm 8.
      FINDING: if a package is listed in the "requires" section of a record in
      package-lock.json, it means it's definitely a regular dependency.
      This is important because records for regular deps of devDependencies are
      listed with "dev": true, which is confusing to human eyes.
    */
    /* istanbul ignore next: a shrinkwrap without a dependencies section is
       not currently worth concern */
    const shrDeps = manifest._shrinkwrap.dependencies || {}
    for (let name in shrDeps) {
      let dep = shrDeps[name]
      if (bundleDeps.includes(name)) continue // No need to fetch a bundled package
      // Cases in which we're not interested in devDependencies:
      if (dep.dev && !(opts.cmd.includeDev && opts.topLevel))
        continue
      // When user said --omit=optional
      if (dep.optional && opts.cmd.noOptional)
        continue

      const pkgId = `${name}@${dep.version}`
      resolvedDeps.push(pkgId)
      if (dep.optional) optionalSet.add(pkgId)
    }
    for (const item of resolvedDeps) {
      operations.push(
        handleItem(item, {
          shrinkwrap: true,
          cmd: opts.cmd,
          dlTracker: opts.dlTracker,
          flatOpts: opts.flatOpts
        })
        .then(arr => xformResult(arr))
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
  else { // No shrinkwrap in this manifest
    const regDeps = manifest.dependencies || {}
    for (let name in regDeps) {
      if (!bundleDeps.includes(name))
        resolvedDeps.push(`${name}@${regDeps[name]}`)
    }
    if (opts.topLevel && opts.cmd.includeDev) {
      /* istanbul ignore next: when --include=dev, we don't care about the case
         of a package with no devDependencies */
      const devDeps = manifest.devDependencies || {}
      for (let name in devDeps) {
        if (!bundleDeps.includes(name))
          resolvedDeps.push(`${name}@${devDeps[name]}`)
      }
    }
    if (opts.cmd.includePeer) {
      const peerDeps = manifest.peerDependencies || {}
      for (let name in peerDeps) {
        if (!bundleDeps.includes(name))
          resolvedDeps.push(`${name}@${peerDeps[name]}`)
      }
    }
    /* istanbul ignore else */
    if (!opts.cmd.noOptional) {
      const optDeps = manifest.optionalDependencies || {}
      for (let name in optDeps) {
        if (!bundleDeps.includes(name)) {
          const pkgId = `${name}@${optDeps[name]}`
          resolvedDeps.push(pkgId)
          optionalSet.add(pkgId)
        }
      }
    }
    for (const item of resolvedDeps) {
      operations.push(
        handleItem(item, {
          cmd: opts.cmd, dlTracker: opts.dlTracker, flatOpts: opts.flatOpts
        })
        .then(arr => xformResult(arr))
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
  handleItem,
  processDependencies,
  xformResult
}
