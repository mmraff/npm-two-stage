// Extracted from packGitDep in npm/lib/pack.js
// for purposes of git-offline

module.exports = prepareRawModule

const cp = require('child_process')
const log = require('npmlog')
const npm = require('./npm')

const PASSTHROUGH_OPTS = [
  'always-auth',
  'auth-type',
  'ca',
  'cafile',
  'cert',
  'git',
  'local-address',
  'maxsockets',
  'offline',
  'offline-dir',
  'prefer-offline',
  'prefer-online',
  'proxy',
  'https-proxy',
  'registry',
  'send-metrics',
  'sso-poll-frequency',
  'sso-type',
  'strict-ssl'
]

function prepareRawModule(pkgJson, dir, spec) {
  if (!pkgJson.scripts || !pkgJson.scripts.prepare) {
    return Promise.resolve(null)
  }
  log.verbose('prepareGitDep', `${spec.raw}: installing devDeps and running prepare script.`)
  const cliArgs = PASSTHROUGH_OPTS.reduce((acc, opt) => {
    if (npm.config.get(opt, 'cli') != null) {
      acc.push(`--${opt}=${npm.config.get(opt)}`)
    }
    return acc
  }, [])
  /* istanbul ignore next: not worth it to muck with these process properties just for coverage */
  const child = cp.spawn(process.env.NODE || process.execPath, [
    require.resolve('../bin/npm-cli.js'),
    'install',
    '--dev',
    '--prod',
    '--ignore-prepublish',
    '--no-progress',
    '--no-save'
  ].concat(cliArgs), {
    cwd: dir,
    env: process.env
  })
  let errData = []
  let errDataLen = 0
  let outData = []
  let outDataLen = 0
  child.stdout.on('data', (data) => {
    outData.push(data)
    outDataLen += data.length
    log.gauge.pulse('preparing git package')
  })
  child.stderr.on('data', (data) => {
    errData.push(data)
    errDataLen += data.length
    log.gauge.pulse('preparing git package')
  })
  // BB.fromNode() code replaced by the following
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code > 0) {
        const err = new Error(`${signal}: npm exited with code ${code} while attempting to build ${spec.raw}. Clone the repository manually and run 'npm install' in it for more information.`)
        err.code = code
        err.signal = signal
        reject(err)
      } else {
        resolve(null)
      }
    })
  }).then(() => {
    if (outDataLen > 0) log.silly('prepareGitDep', '1>', Buffer.concat(outData, outDataLen).toString())
    if (errDataLen > 0) log.silly('prepareGitDep', '2>', Buffer.concat(errData, errDataLen).toString())
  }, (err) => {
    if (outDataLen > 0) log.error('prepareGitDep', '1>', Buffer.concat(outData, outDataLen).toString())
    /* istanbul ignore else: impossible for there to be no error output when there was an error */
    if (errDataLen > 0) log.error('prepareGitDep', '2>', Buffer.concat(errData, errDataLen).toString())
    throw err
  })
}
