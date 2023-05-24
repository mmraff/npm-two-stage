/*
  Based on pacote/lib/git.js.
  Added requires: ssri, util.promisify, promisify(fs.readFile).
  Added method: [_istream].
  We use this only to get the manifest from a git repo, but in the process,
  we clone, and we also cache a tarball made from the clone.
*/
  
const Fetcher = require('pacote/lib/fetcher.js')
const DirFetcher = require('pacote/lib/dir.js')
const hashre = /^[a-f0-9]{40}$/
const git = require('@npmcli/git')
const npa = require('npm-package-arg')
const path = require('path')
const url = require('url')
const cacache = require('cacache')
const log = require('proc-log')
const npm = require('pacote/lib/util/npm.js')
const ssri = require('ssri')

const { promisify } = require('util')
const readfile = promisify(require('fs').readFile)

const _tarballFromResolved = Symbol.for('pacote.Fetcher._tarballFromResolved')
const _addGitSha = Symbol('_addGitSha')
const addGitSha = require('pacote/lib/util/add-git-sha.js')
const _clone = Symbol('_clone')
const _cloneHosted = Symbol('_cloneHosted')
const _cloneRepo = Symbol('_cloneRepo')
const _setResolvedWithSha = Symbol('_setResolvedWithSha')
const _prepareDir = Symbol('_prepareDir')
const _istream = Symbol('_istream2')
const _readPackageJson = Symbol.for('package.Fetcher._readPackageJson')

// get the repository url.
// prefer https if there's auth, since ssh will drop that.
// otherwise, prefer ssh if available (more secure).
// We have to add the git+ back because npa suppresses it.
const repoUrl = (h, opts) =>
  h.sshurl && !(h.https && h.auth) && addGitPlus(h.sshurl(opts)) ||
  h.https && addGitPlus(h.https(opts))

// add git+ to the url, but only one time.
const addGitPlus = _url => _url && `git+${_url}`.replace(/^(git\+)+/, 'git+')

const filterAliases = arr => arr.filter(s => s !== 'HEAD' && !s.startsWith('refs/'))

class AltGitFetcher extends Fetcher {
  constructor (spec, opts) {
    super(spec, opts)

    // we never want to compare integrity for git dependencies: npm/rfcs#525
    if (this.opts.integrity) {
      delete this.opts.integrity
      log.warn(`skipping integrity check for git dependency ${this.spec.fetchSpec}`)
    }

    this.resolvedRef = null
    if (this.spec.hosted) {
      this.from = this.spec.hosted.shortcut({ noCommittish: false })
    }

    // shortcut: avoid full clone when we can go straight to the tgz
    // if we have the full sha and it's a hosted git platform
    if (this.spec.gitCommittish && hashre.test(this.spec.gitCommittish)) {
      this.resolvedSha = this.spec.gitCommittish
      // use hosted.tarball() when we shell to RemoteFetcher later
      this.resolved = this.spec.hosted
        ? repoUrl(this.spec.hosted, { noCommittish: false })
        : this.spec.rawSpec
    } else {
      this.resolvedSha = ''
    }
  }

  // just exposed to make it easier to test all the combinations
  static repoUrl (hosted, opts) {
    return repoUrl(hosted, opts)
  }

  get types () {
    return ['git']
  }

  [_setResolvedWithSha] (withSha) {
    // we haven't cloned, so a tgz download is still faster
    // of course, if it's not a known host, we can't do that.
    this.resolved = !this.spec.hosted ? withSha
      : repoUrl(npa(withSha).hosted, { noCommittish: false })
  }

  // when we get the git sha, we affix it to our spec to build up
  // either a git url with a hash, or a tarball download URL
  [_addGitSha] (sha) {
    this[_setResolvedWithSha](addGitSha(this.spec, sha))
  }

  [_prepareDir] (dir) {
    // The npm developers keep doing things that cause problems on Windows.
    // Here they had: dir + '/package.json'
    return this[_readPackageJson](path.join(dir, 'package.json')).then(mani => {
      // no need if we aren't going to do any preparation.
      const scripts = mani.scripts
      if (!mani.workspaces && (!scripts || !(
          scripts.postinstall ||
          scripts.build ||
          scripts.preinstall ||
          scripts.install ||
          scripts.prepack ||
          scripts.prepare))) {
        return
      }

      // to avoid cases where we have an cycle of git deps that depend
      // on one another, we only ever do preparation for one instance
      // of a given git dep along the chain of installations.
      // Note that this does mean that a dependency MAY in theory end up
      // trying to run its prepare script using a dependency that has not
      // been properly prepared itself, but that edge case is smaller
      // and less hazardous than a fork bomb of npm and git commands.
      const noPrepare = !process.env._PACOTE_NO_PREPARE_ ? []
        : process.env._PACOTE_NO_PREPARE_.split('\n')
      if (noPrepare.includes(this.resolved)) {
        log.info('prepare', 'skip prepare, already seen', this.resolved)
        return
      }
      noPrepare.push(this.resolved)

      // the DirFetcher will do its own preparation to run the prepare scripts
      // All we have to do is put the deps in place so that it can succeed.
      return npm(
        this.npmBin,
        [].concat(this.npmInstallCmd).concat(this.npmCliConfig),
        dir,
        { ...process.env, _PACOTE_NO_PREPARE_: noPrepare.join('\n') },
        { message: 'git dep preparation failed' }
      )
    })
  }

  /*
    Based on Fetcher[_istream], which is inaccessible to derived classes
    (its declaration up top is Symbol(_istream) instead of Symbol.for(_istream)).
    For explanation of specifics in this, see comments in Fetcher[_istream].
  */
  [_istream] (srcStream) {
    const istream = ssri.integrityStream(this.opts)
    istream.on('integrity', i => this.integrity = i)
    istream.on('data', () => {}) // THIS IS THE TICKET
    srcStream.on('error', err => {
      srcStream.destroy()
      istream.emit('error', err)
    })

    srcStream.pipe(istream, { end: false })
    const cstream = cacache.put.stream(
      this.opts.cache,
      `pacote:tarball:${this.from}`,
      this.opts
    )
    srcStream.pipe(cstream)
    // defer istream end until after cstream
    // cache write errors should not crash the fetch, this is best-effort.
    cstream.promise().catch(err => {
      log.warn('AltGitFetcher[_istream]', 'cache write error:', err.message)
    })
    .then(() => istream.end())

    return istream
  }

  // clone a git repo into a temp folder.
  // handler accepts a directory, and returns a promise that resolves
  // when we're done with it, at which point, cacache deletes it
  //
  [_clone] (handler) {
    const o = { tmpPrefix: 'git-clone' }
    const ref = this.resolvedSha || this.spec.gitCommittish
    const h = this.spec.hosted
    const resolved = this.resolved

    return cacache.tmp.withTmp(this.cache, o, async tmp => {
      const sha = await (
        h ? this[_cloneHosted](ref, tmp)
        : this[_cloneRepo](this.spec.fetchSpec, ref, tmp)
      )
      this.resolvedSha = sha
      if (!this.resolved) {
        await this[_addGitSha](sha)
      }
      if (this.opts.multipleRefs) {
        const tmpFileURL = url.pathToFileURL(tmp).href
        const remoteRefs = await git.revs(tmpFileURL, this.opts)
        if (remoteRefs) {
          const list = remoteRefs.shas[sha]
          const aliases = list && (list instanceof Array) && filterAliases(list)
          this.allRefs = aliases || []
        }
      }
      // Make a tarball, put it in the cache
      await this[_prepareDir](tmp)
      const df = new DirFetcher(`file:${tmp}`, {
        ...this.opts,
        resolved: null,
        integrity: null,
      })
      const dirStream = df[_tarballFromResolved]()
      return new Promise((resolve, reject) => {
        const istream = this[_istream](dirStream, this.opts)
        istream.on('error', err => reject(err))
        istream.on('finish', () => resolve(null))
      })
      .then(() =>  handler(tmp))
    })
  }

  // first try https, since that's faster and passphrase-less for
  // public repos, and supports private repos when auth is provided.
  // Fall back to SSH to support private repos
  // NB: we always store the https url in resolved field if auth
  // is present, otherwise ssh if the hosted type provides it
  //
  [_cloneHosted] (ref, tmp) {
    const hosted = this.spec.hosted
    return this[_cloneRepo](hosted.https({ noCommittish: true }), ref, tmp)
      .catch(er => {
        // Throw early since we know pathspec errors will fail again if retried
        if (er instanceof git.errors.GitPathspecError) {
          throw er
        }
        const ssh = hosted.sshurl && hosted.sshurl({ noCommittish: true })
        // no fallthrough if we can't fall through or have https auth
        if (!ssh || hosted.auth) {
          throw er
        }
        return this[_cloneRepo](ssh, ref, tmp)
      })
  }

  [_cloneRepo] (repo, ref, tmp) {
    const { opts, spec } = this
    return git.clone(repo, ref, tmp, { ...opts, spec })
  }

  manifest () {
    if (this.package) { // The already-annotated manifest
      return Promise.resolve(this.package)
    }

    // For a hosted repo with a resolved spec (a commit hash), GitFetcher
    // resorts to using the FileFetcher method, which gets a tarball.
    // We don't do that here because a tarball does not give us a rev doc,
    // which we'd really like to have. Force a clone, or get from cache.

    // THIS NOTE IS UNIMPORTANT, I think. Just a mild concern.
    // Note that the DirFetcher created in [_clone] (to create a tarball to
    // put in the cache) also calls readPackageJson on the same directory,
    // so that it can run scripts from the package.json "scripts" section
    // in DirFetcher[_prepareDir].

    const handler = (dir) =>
      this[_readPackageJson](path.join(dir, 'package.json'))
      .then(mani => this.package = Object.assign(
        {
          ...mani,
          _resolved: this.resolved,
          _from: this.from,
          _sha: this.resolvedSha
        },
        this.opts.multipleRefs ? { _allRefs: this.allRefs } : {}
      ))

    return this[_clone](handler)
  }
}
module.exports = AltGitFetcher
