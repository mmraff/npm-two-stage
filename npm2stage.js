#!/usr/bin/env node

const { Command } = require('commander')
const { install, installProgress } = require('./lib/install')
const { uninstall, uninstallProgress } = require('./lib/uninstall')
const { getStatus, statusProgress } = require('./lib/status')
const { errorCodes: ERRS } = require('./lib/constants')

const program = new Command()
const { version: pkgVersion, bin: pkgBin } = require('./package.json')
const progName = (() => { for (let prop in pkgBin) return prop })()
const ADVICE_TO_UNINSTALL = [
  '',
  '   The remains of a previous installation of npm-two-stage were found.',
  '   This complicates the current installation, so it will be aborted.',
  `   The best action to take now is to run \`${progName} uninstall\` using the`,
  '   same npm-two-stage version as when the previous installation was run.'
].join('\n')

program
  .name(progName)
  .version(pkgVersion)
/*
// TODO: replace this with .addHelpText('after', `whatever ...`)
  .usage(
    [
      '[options] [NPM_DIRECTORY]',
      '',
      'TODO: more description, like what happens when user does not give NPM_DIRECTORY.',
    ].join('\n')
  )
*/

program
  .command('install [npmPath]')
  .alias('i')
  .option('-s, --silent', 'No console output unless error')
  .action((npmPath, options) => {
    if (!options.silent) {
      installProgress.on('msg', msg => console.log('  ', msg))
    }
    console.log('')
    install(npmPath).then(() => {
      if (!options.silent)
        console.log('\n   Installation of npm-two-stage was successful.\n')
    })
    .catch(err => {
      console.error(`ERROR: ${err.message}`)
      if (!options.silent) {
        if (err.exitcode == ERRS.LEFTOVERS)
          console.warn(ADVICE_TO_UNINSTALL)
      }
      process.exitCode = err.exitcode || 1
    })
  })

program
  .command('uninstall [npmPath]')
  .alias('un')
  .option('-s, --silent', 'No console output unless error')
  .action((npmPath, options) => {
    if (!options.silent) {
      uninstallProgress.on('msg', msg => console.log('  ', msg))
    }
    console.log('')
    uninstall(npmPath).then(() => {
      if (!options.silent)
        console.log('\n   Removal of npm-two-stage was successful.\n')
    })
    .catch(err => {
      console.error(`ERROR: ${err.message}`)
      process.exitCode = err.exitcode || 1
    })
  })

program
  .command('status [npmPath]')
  .action(npmPath => {
    statusProgress.on('msg', msg => console.log('  ', msg))
    console.log('')
    getStatus(npmPath).then(() => {
      console.log('')
    })
    .catch(err => {
      console.error(`ERROR: ${err.message}`)
    })
  })

program.parse()
