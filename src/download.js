// built-in packages
const fs = require('fs')
const path = require('path')
const url = require('url')
const util = require('util')

// 3rd party
const log = require('npmlog')
const mkdirp = require('mkdirp')
const pacote = require('pacote')
const rimraf = require('rimraf')

// npm/download internals
const BaseCommand = require('./base-command')
const dltFactory = require('./download/dltracker')
const npf = require('./download/npm-package-filename')
const {
  handleItem,
  processDependencies,
  xformResult
} = require('./download/item-agents')

class Download extends BaseCommand {
  /* istanbul ignore next - see test/lib/load-all-commands.js */
  static get description () {
    return 'Download packages and dependencies as tarballs'
  }

  /* istanbul ignore next - see test/lib/load-all-commands.js */
  static get name () {
    return 'download'
  }

  /* istanbul ignore next - see test/lib/load-all-commands.js */
  static get params () {
    return [
      'dl-dir',
      // We can't include the package-json option here, because nopt failed to
      // handle its definition correctly when there was one; and base-command
      // requires a definition in utils/config/definitions.js for any item
      // that appears here.
      //'package-json', 
      'package-lock',
      'include',
      'omit',
      'only',
      'before'
    ]
  }

  /* istanbul ignore next - see test/lib/load-all-commands.js */
  static get usage () {
    // NOTE anything in this array gets automatically prefixed with
    // 'npm download ' for output.
    return [
      '[<@scope>/]<pkg>',
      '[<@scope>/]<pkg>@<tag>',
      '[<@scope>/]<pkg>@<version>',
      '[<@scope>/]<pkg>@<version range>',
      '<github username>/<github project>',
      '<git-host>:<git-user>/<repo-name>',
      '<git:// url>',
      '<tarball url>',
    ]
  }

  exec (args, cb) {
    this.download(args, cb)
  }

  download(args, cb) {
    log.silly('download', 'args:', args)

    const self = this
    const flatOpts = {
      ...this.npm.flatOptions,
      log: this.npm.log,
      auditLevel: null, // Not used in pacote! TODO: eliminate?
      workspaces: this.workspaceNames // TODO: ditto.
    }
    const cmdOpts = {
      dlDir: this.npm.config.get('dl-dir'),
      phantom: this.npm.config.get('dl-phantom'), // Still unimplemented
    }

    const optInclude = this.npm.config.get('include')
    const optOmit = this.npm.config.get('omit')
    if (!optInclude.includes('optional') && optOmit.includes('optional'))
      cmdOpts.noOptional = true
    if (optInclude.includes('dev')) cmdOpts.includeDev = true
    if (optInclude.includes('peer')) cmdOpts.includePeer = true
    // definitions.js addresses problem of '--omit' args also given
    // as '--include' args, so we don't worry about that here.

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
    if (!this.npm.config.get('package-lock')) cmdOpts.noShrinkwrap = true

    const optPj =
      this.npm.config.get('package-json') ||
      this.npm.config.get('pj') || this.npm.config.get('J')
    if (optPj) {
      cmdOpts.packageJson = typeof optPj == 'boolean' ? './' : optPj
      const pjFilePattern = /package\.json$/
      if (pjFilePattern.test(cmdOpts.packageJson))
        cmdOpts.packageJson = cmdOpts.packageJson.replace(pjFilePattern, '')
      if (!cmdOpts.packageJson) cmdOpts.packageJson = './'
    }

    if (!cmdOpts.packageJson && (!args || args.length == 0)) {
      return cb(new SyntaxError([
        'No packages named for download.',
        'Maybe you want to use the package-json option?',
        'Try: npm download -h'
      ].join('\n')))
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

    dltFactory.create(cmdOpts.dlDir, { log: log }).then(newTracker => {
      log.info('download', 'established download path:', newTracker.path)
      self.dlTracker = newTracker
      return mkdirp(tempCache)
    })
    .then(() => {
      if (!cmdOpts.packageJson) return []

      return pacote.manifest(cmdOpts.packageJson, { ...flatOpts })
      .then(mani => {
        return processDependencies(mani, {
          topLevel: true,
          cmd: cmdOpts,
          dlTracker: self.dlTracker,
          flatOpts
        })
        .then(results => {
          const pjResults = xformResult(results)
          statsMsgs = getItemResultsStats('package.json', pjResults)
          return pjResults
        })
      })
    })
    .then(pjResults => {
      if (args.length) {
        const operations = []
        for (const item of args)
          operations.push(
            handleItem(item, {
              topLevel: true,
              cmd: cmdOpts,
              dlTracker: self.dlTracker,
              flatOpts
            })
            .then(results => {
              statsMsgs += getItemResultsStats(item, results)
              return results
            })
          )
        return Promise.all(operations).then(results => {
          if (pjResults.length) results = pjResults.concat(results)
          return results
        })
      }
      else return pjResults
    })
    .then(results => {
      // results is an array of arrays, 1 for each spec on the command line.
      rimraf(tempCache, function(rimrafErr) {
        /* istanbul ignore if: a condition not worth the overhead of testing */
        if (rimrafErr)
          log.warn('download', 'failed to delete the temp dir ' + tempCache)

        self.dlTracker.serialize().then(() => {
          self.npm.output(statsMsgs + '\n\ndownload finished.')
          // QUESTION: Why are we returning results? Who is the caller, and
          // does it do anything with them?
          // Keep in mind that we have written tests to expect the results...
          cb(null, results)
        })
      })
    })
    .catch(err => cb(err))
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
    if (item == 'package.json')
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

