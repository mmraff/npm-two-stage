const { mkdir, rm } = require('fs/promises')
const path = require('path')
const url = require('url')
const util = require('util')

const pacote = require('pacote')

const BaseCommand = require('../base-command')
const dltFactory = require('../download/dltracker')
const lockDeps = require('../download/lock-deps')
const log = require('../utils/log-shim.js')
const npf = require('../download/npm-package-filename')
const {
  getOperations,
  processDependencies,
  xformResult
} = require('../download/item-agents')

class Download extends BaseCommand {
  static description = 'Download package(s) and dependencies as tarballs'
  static name = 'download'

  static params = [
    'dl-dir',
    'lockfile-dir',
    'package-json',
    'include',
    'omit',
    'package-lock',
  ]

  static usage = ['[<package-spec> ...]']

  async exec (args) {
    log.silly('download', 'args:', args)

    const self = this
    const flatOpts = {
      ...this.npm.flatOptions,
    }
    const cmdOpts = {
      dlDir: this.npm.config.get('dl-dir'),
      //phantom: this.npm.config.get('dl-phantom'), // Still unimplemented
    }

    const optInclude = this.npm.config.get('include')
    const optOmit = this.npm.config.get('omit')
    if (!optInclude.includes('optional') && optOmit.includes('optional')) {
      cmdOpts.noOptional = true
    }
    if (!optInclude.includes('peer') && optOmit.includes('peer')) {
      cmdOpts.noPeer = true
    }
    if (optInclude.includes('dev')) {
      cmdOpts.includeDev = true
    }

    // --only: deprecated.
    // There's support for it (in definitions.js), but the only values
    // recognized are null, 'prod', 'production'.
    // definitions.js handles the valid values by putting 'dev' on the
    // omit list. If not given, 'dev' *might* be put on the include list.

    // --also: deprecated.
    // There's support for it (in definitions.js), but the only values
    // recognized are null, 'dev', 'development'.
    // definitions.js handles it by putting 'dev' on the include list.

    // --shrinkwrap: deprecated.
    // definitions.js interprets it as 'Alias for --package-lock' for now.
    // Therefore, --shrinkwrap=false => --package-lock=false.
    // --package-lock default is true.
    if (this.npm.config.get('package-lock') == false) {
      cmdOpts.noShrinkwrap = true
    }

    const pkgJson = this.npm.config.get('package-json')
    const J = this.npm.config.get('J')

    // nopt and/or @npmcli/config is mishandling the arg processing, causing a
    // double-hyphen cmdline option without an argument to consume the next
    // cmdline option as its argument. Handle this case by examining the value
    // of package-json, looking for a hyphen as the 1st character:
    let optPj
    if (pkgJson) {
      if (typeof pkgJson !== 'string' || pkgJson.startsWith('-')) {
        throw new Error('package-json option must be given a path')
      }
      // For consistency:
      optPj = pkgJson === '.'
        ? './'
        : pkgJson === '..' ? '../' : pkgJson
      // A relative path without a dot prefix gets mishandled,
      // something like the way a bash script in the current directory is
      // not found unless it is dot-prefixed:
      if (!path.isAbsolute(optPj) && !/^\.\.?[/\\]/.test(optPj)) {
        optPj = './' + optPj
      }
    }
    else if (J) {
      /* istanbul ignore if: we're not hitting this given current config. */
      if (typeof J !== 'boolean') {
        throw new Error('@npmcli/config is mishandling args: J is set to ' + J)
      }
      optPj = './'
    }
    if (optPj) {
      // The processing above ensures that even if optPj ends with
      // 'package.json', there is always a non-empty prefix
      cmdOpts.packageJson = optPj.replace(/(^|[/\\])package\.json$/, '$1')
    }

    // Same issue as above for the lockfile directory option
    const lockfileDir = this.npm.config.get('lockfile-dir')
    if (lockfileDir) {
      if (typeof lockfileDir !== 'string' || lockfileDir.startsWith('-')) {
        throw new Error('lockfile-dir option must be given a path')
      }
      cmdOpts.lockfileDir = lockfileDir === '.'
        ? './'
        : lockfileDir === '..' ? '../' : lockfileDir
      if (!path.isAbsolute(cmdOpts.lockfileDir)
          && !/^\.\.?[/\\]/.test(cmdOpts.lockfileDir)) {
        cmdOpts.lockfileDir = path.normalize('./') + cmdOpts.lockfileDir
      }
      if (lockfileDir.endsWith('npm-shrinkwrap.json')) {
        cmdOpts.lockfileDir = lockfileDir.replace(/(^|[/\\])npm-shrinkwrap\.json$/, '')
      }
      else if (lockfileDir.endsWith('package-lock.json')) {
        cmdOpts.lockfileDir = lockfileDir.replace(/(^|[/\\])package-lock\.json$/, '')
      }
      else if (lockfileDir.endsWith('yarn.lock')) {
        cmdOpts.lockfileDir = lockfileDir.replace(/(^|[/\\])yarn.lock$/, '')
      }
      if (!cmdOpts.lockfileDir) {
        cmdOpts.lockfileDir = './'
      }
    }

    if (!cmdOpts.packageJson && !cmdOpts.lockfileDir &&
        (!args || args.length == 0)) {
      throw new Error([
        'No packages named for download.',
        'Maybe you want to use the package-json or lockfile-dir option?',
        'Try: npm download -h'
      ].join('\n'))
    }

    // Because we will pass it to something external:
    Object.freeze(cmdOpts)

    if (cmdOpts.dlDir) {
      log.info('download', 'requested path:', cmdOpts.dlDir)
    }
    else {
      log.warn('download',
        'No path configured for downloads - current directory will be used.'
      )
    }

    // INTEGRATION TEST shows that the last component of this path is not 
    // honored by pacote fetcher.js, which passes path.dirname() of the value
    // from opts.cache to the child_process:
    const tempCache = path.join(cmdOpts.dlDir || '.', 'dl-temp', 'cache')
    flatOpts.cache = tempCache

    let statsMsgs = ''

    return dltFactory.create(cmdOpts.dlDir, { log })
    .then(newTracker => {
      log.info('download', 'established download path:', newTracker.path)
      self.dlTracker = newTracker
      return mkdir(tempCache, { recursive: true })
    })
    .then(() => {
      if (!cmdOpts.packageJson) {
        return []
      }

      // Get an annotated version of the package.json at the given local path
      return pacote.manifest(cmdOpts.packageJson, { ...flatOpts })
      .then(mani =>
        processDependencies(mani, {
          topLevel: true,
          cmd: cmdOpts,
          dlTracker: self.dlTracker,
          flatOpts
        })
        .then(results => {
          const pjResults = xformResult(results)
          statsMsgs = getItemResultsStats('package.json', pjResults)
          return [ pjResults ]
        })
      )
    })
    .then(prevResults => {
      const baseDir = cmdOpts.lockfileDir
      if (!baseDir) {
        return prevResults
      }

      // Note there are warnings logged but no error if no lockfile is found
      // at the given lockfileDir
      return lockDeps.readFromDir(baseDir, log)
      .then(deps => {
        if (!deps.length) {
          return prevResults
        }

        const operations = getOperations(deps, {
          lockfile: true, topLevel: true,
          cmd: cmdOpts, dlTracker: self.dlTracker, flatOpts
        })
        return Promise.all(operations).then(results => {
          const lockResults = xformResult(results)
          statsMsgs += getItemResultsStats('lockfile', lockResults)
          return prevResults.concat([ lockResults ])
        })
      })
    })
    .then(pjLockResults => {
      if (!args.length) {
        return pjLockResults
      }

      const operations = getOperations(args, {
        topLevel: true,
        cmd: cmdOpts, dlTracker: self.dlTracker, flatOpts
      })
      for (let i = 0; i < operations.length; ++i) {
        // We take advantage of the fact that operations[i] corresponds to
        // args[i], because no command line spec gets filtered out
        operations[i] = operations[i].then(results => {
          statsMsgs += getItemResultsStats(args[i], results)
          return results
        })
      }
      return Promise.all(operations).then(results => {
        return pjLockResults.concat(results)
      })
    })
    .then(async results => {
      // results is an array of arrays, 1 for each spec on the command line
      // (+1 for package-json opt if any; +1 for lockfile opt if any)
      await self.dlTracker.serialize()
      await rm(path.dirname(tempCache), {
        recursive: true, force: true,
        maxRetries: 4, retryDelay: 1000
      })
      .catch(err => {
        // TODO: either concoct tests for this, or do istanbul ignore
        if (err.code == 'EPERM' || err.code == 'EBUSY') {
          return log.warn('download', `
  The operating system does not want to let go of the temporary directory.
  You should manually delete this when you can, since it's not needed:
  ${path.dirname(tempCache)}\n`
          )
        }
        log.warn('download', 'Mystery error on removing the temp dir:', err.message)
        // but this is not bad enough to crash the operation...
        // after all, we're finished
      })

      self.npm.output(statsMsgs + '\n\ndownload finished.')
      // QUESTION: Why are we returning results? Who is the caller, and
      // does it do anything with them?
      // Keep in mind that we have written tests to expect the results...
      return results
    })
  }
}
module.exports = Download

function getItemResultsStats(item, results) {
  const stats = []
  let filtered = results.filter(res => !res.duplicate)
  const dupCount = results.length - filtered.length
  filtered = filtered.filter(res => !res.failedOptional)
  const failedOptCount = (results.length - filtered.length) - dupCount
  if (filtered.length) {
    if (item == 'package.json' || item == 'lockfile')
      stats.push(util.format(
        '\nDownloaded tarballs to satisfy %i dependenc%s derived from %s',
        filtered.length,
        /* istanbul ignore next: trivial */
        filtered.length == 1 ? 'y' : 'ies', item
      ))
    else
      stats.push(util.format(
        '\nDownloaded tarballs to satisfy %s and %i dependenc%s',
        item, filtered.length - 1,
        /* istanbul ignore next: trivial */
        filtered.length == 2 ? 'y' : 'ies'
      ))
  }
  else
    stats.push(util.format('\nNothing new to download for', item))
  if (failedOptCount)
    stats.push(util.format(
      '(failed to fetch %i optional packages)', failedOptCount
    ))
  if (dupCount)
    stats.push(util.format(
      '(%i duplicate spec%s skipped)', dupCount,
      /* istanbul ignore next: trivial */
      dupCount > 1 ? 's' : ''
    ))
  return stats.join('\n')
}
