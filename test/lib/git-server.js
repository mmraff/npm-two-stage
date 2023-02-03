/*
  Extracted/adapted from pacote v11.3.5 test/git.js
*/
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const spawnGit = require('@npmcli/git').spawn
const spawnNpm = require('pacote/lib/util/npm')

let daemonPID
let hostBase

// port: ephemeral port on which the daemon should listen.
// base: path where repos and the cache are located.
exports.start = function startDaemon(port, base) {
  if (daemonPID) {
    return Promise.reject(new Error('git daemon already started'))
  }
  return new Promise((resolve, reject) => {
    let daemon
    try {
      daemon = spawn('git', [
        'daemon',
        `--port=${port}`,
        '--export-all',
        '--verbose',
        '--informative-errors',
        '--reuseaddr',
        '--base-path=.',
        '--listen=localhost',
      ], { cwd: base, stdio: [ 'pipe', 1, 'pipe' ] })
    }
    catch (err) { return reject(err) }
    const onDaemonData = c => {
      // we need the PID of the daemon to end it; it is emitted on startup
      const cpid = c.toString().match(/^\[(\d+)\]/)
      if (!cpid || !cpid[1]) return
      daemon.stderr.removeListener('data', onDaemonData)
      daemonPID = +cpid[1]
      exports.stop = () => new Promise((resolve, reject) => {
        if (!daemonPID)
          return reject(new Error('git daemon not running'))
        daemon.on('close', () => {
          daemonPID = undefined
          resolve()
        })
        try {
          process.kill(daemonPID)
        }
        catch (err) {
          // If we still have a PID, but the system can't find a running
          // process that has it, something must have killed it already
          // in a way that evaded the close event
          if (err.code === 'ESRCH') {
            daemonPID = undefined
            resolve()
          }
          else reject(err)
        }
      })
      hostBase = base
      resolve()
    }
    daemon.stderr.on('data', onDaemonData)
  })
}

const initializeRepo = async (repoPath) => {
  const git = (...cmd) => spawnGit(cmd, { cwd: repoPath })

  fs.mkdirSync(repoPath)
  await git('init')
  await git('config', 'user.name', 'n2s7dev')
  await git('config', 'user.email', 'n2s7dev@npm2stage.io')
  await git('config', 'tag.gpgSign', 'false')
  await git('config', 'commit.gpgSign', 'false')
  await git('config', 'tag.forceSignAnnotated', 'false')
}

let repoCount = 0

exports.createRepo = async (repoName, cfg, npmBin) => {
  if (!hostBase)
    return Promise.reject(new Error('Base path for repos has not been set!'))

  const commits = []
  const repoPath = path.join(hostBase, repoName)
  const git = (...cmd) => spawnGit(cmd, { cwd: repoPath })
  const write = (f, c) => fs.writeFileSync(path.join(repoPath, f), c)
  const npm = (...cmd) => spawnNpm(
    npmBin + (process.platform === 'win32' ? '.cmd' : ''), [
      ...cmd,
      '--no-sign-git-commit',
      '--no-sign-git-tag',
    ], repoPath)

  if (!cfg) cfg = {}

  const pkgJson = {
    name: repoName,
    version: '0.0.1',
    description: 'git test asset ' + ++repoCount,
    files: [
      'index.js'
    ],
  }
  if (cfg.deps) pkgJson.dependencies = { ...cfg.deps }
  if (cfg.devDeps) pkgJson.devDependencies = { ...cfg.devDeps }
  if (cfg.scripts) pkgJson.scripts = { ...cfg.scripts }

  await initializeRepo(repoPath)
  await write('package.json', JSON.stringify(pkgJson))
  await git('add', 'package.json')
  await git('commit', '-m', 'package json file')

  // We will use the name 'items' instead of 'files', because the latter has a
  // specific definition in a package.json, and we want to avoid ambiguity:
  if (cfg.items) {
    for (data of cfg.items) {
      await write(data.filename, data.content)
      await git('add', data.filename)
      await git('commit', '-m', data.message)
      // From the npm doc for `npm version`:
      // "If run in a git repo, it will also create a version commit and tag."
      if (data.version) await npm('version', data.version)
      const cmt = data.getCommit ?
        (await git('rev-parse', 'HEAD')).stdout.trim() : null
      commits.push(cmt)
    }
  }
  return commits
}
