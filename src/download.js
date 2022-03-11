// built-in packages
const fs = require('fs')
const path = require('path')
const url = require('url')
const util = require('util')

// 3rd party
const log = require('npmlog') // TODO: might be obligated to switch to npm.log instance
const mkdirp = require('mkdirp')
const pacote = require('pacote')
const rimraf = require('rimraf')

// npm/download internals
const BaseCommand = require('./base-command')
const cfg = require('./download/config')
const dltFactory = require('./download/dltracker')
const npf = require('./download/npm-package-filename')
const {
  handleItem,
  processDependencies,
  xformResult
} = require('./download/item-agents')

class Download extends BaseCommand {
  static get description () {
    return 'Download package(s) and dependencies as tarballs'
  }

  static get name () {
    return 'download'
  }

  // TODO: find out how Options get listed with shorthands and aliases for npm commands!
  // TODO: remove the deprecated ones from below; add new ones (e.g., package-lock)
  static get params () {
    return [
      'dl-dir',
      'include',
      'omit',
      'only',
      'package-json'
    ]
  }

  static get usage () {
    return [
      '[<@scope>/]<pkg>',
      '[<@scope>/]<pkg>@<tag>',
      '[<@scope>/]<pkg>@<version>',
      '[<@scope>/]<pkg>@<version range>',
      '<github username>/<github project>',
      '<git-host>:<git-user>/<repo-name>',
      '<git:// url>',
      '<tarball url>',
/*
// TODO: make sure the following output somehow gets conveyed in the usage.
// This won't work. See base-command.js.
      [
        '',
        'Multiple items can be named as above on the same command line.',
        'Alternatively, dependencies can be drawn from a package.json file:',
        '',
        '  npm download --package-json[=<path-with-a-package.json>]',
        '  npm download --pj[=<path-with-a-package.json>]',
        '  npm download -J',
        '',
        'If <path-with-a-package.json> is not given, the package.json file is',
        'expected to be in the current directory.',
        'The last form assumes this.'
      ].join('\n'),
*/
    ]
  }

  exec (args, cb) {
    this.download(args, cb)
  }

  download(args, cb) {
    log.silly('download', 'args:', args)

    const cmdOpts = {
      dlDir: this.npm.config.get('dl-dir'),
      phantom: this.npm.config.get('dl-phantom'), // Still unimplemented
    }

    const optInclude = this.npm.config.get('include')
    if (optInclude.includes('dev')) cmdOpts.includeDev = true
    if (optInclude.includes('peer')) cmdOpts.includePeer = true
    // definitions.js addresses problem of '--omit' args also given
    // as '--include' args, so we don't worry about that here.
    const optOmit = this.npm.config.get('omit')
    if (optOmit.includes('optional')) cmdOpts.noOptional = true

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
    // We have not yet dealt with package-lock.json here. TODO: Should we?
    // TODO: Get answer to the question: when we get a manifest from the
    // npmjs repository, and it has a _shrinkwrap property, does that ever
    // come from a package-lock.json instead of a npm-shrinkwrap.json?
    // The answer will determine if we add code to read a package-lock.json
    // from a git repo clone.
    if (!this.npm.config.get('package-lock')) cmdOpts.noShrinkwrap = true

    const optPj =
      this.npm.config.get('package-json') ||
      this.npm.config.get('pj') || this.npm.config.get('J')
    if (optPj) {
      cmdOpts.packageJson = typeof optPj == 'boolean' ? './' : optPj
      cmdOpts.packageJson.replace(/package\.json$/, '')
      if (!cmdOpts.packageJson) cmdOpts.packageJson = './'
    }

    if (!(cmdOpts.packageJson || (args && args.length > 0))) {
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

    const tempCache = path.join(cmdOpts.dlDir || '.', 'dl-temp-cache')
    cfg.set('cache', tempCache)
    cfg.set('log', log)
    cfg.set('opts', cmdOpts)

    let statsMsgs = ''

    dltFactory.create(cmdOpts.dlDir, { log: log }).then(newTracker => {
      log.info('download', 'established download path:', newTracker.path)
      cfg.set('dlTracker', newTracker)
      cfg.freeze()
      return mkdirp(tempCache)
    })
    .then(() => {
      if (!cmdOpts.packageJson) return []

      return pacote.manifest(cmdOpts.packageJson).then(mani => {
        return processDependencies(mani, { topLevel: true })
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
            handleItem(item, { topLevel: true })
            .then(results => {
if (!results)
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!! download: no results resolved for', item)
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
        if (rimrafErr)
          log.warn('download', 'failed to delete the temp dir ' + tempCache)

          cfg.get('dlTracker').serialize().then(() => {
          // The console call follows the callback call here because when
          // placed before, it causes a stutter in the npm log output.
          // TODO: try npm.output()
          cb(null, results)
          console.info(statsMsgs, '\n\ndownload', 'finished.')
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
        filtered.length, filtered.length == 1 ? 'y' : 'ies', item
      ))
    else
      stats.push(util.format(
        '\nDownloaded tarballs to satisfy %s and %i dependenc%s',
        item, filtered.length - 1, filtered.length == 2 ? 'y' : 'ies'
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
      '(%i duplicate spec%s skipped)', dupCount, dupCount > 1 ? 's' : ''
    ))
  return stats.join('\n')
}
