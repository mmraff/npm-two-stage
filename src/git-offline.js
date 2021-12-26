const path = require('path')

const BB = require('bluebird')
const execFileAsync = BB.promisify(require('child_process').execFile, {
  multiArgs: true
})
const log = require('npmlog')
const mkdirp = BB.promisify(require('mkdirp'))
const npa = require('npm-package-arg')
const packlist = require('npm-packlist')
const readJson = BB.promisify(require('read-package-json'))
const statAsync = BB.promisify(require('graceful-fs').stat)
const tar = require('tar')

const DlTracker = require('./download/dltracker')
const gitAux = require('./download/git-aux')
const gitContext = require('./download/git-context')
const npm = require('./npm')
const prepRawModule = require('./prepare-raw-module')
const lifecycle = BB.promisify(require('./utils/lifecycle'))
const getContents = require('./pack').getContents

/*
OPTS of interest here ------------------
---------------------
* uid, gid (mkOpts)
* log
* git
* dirPacker?
*/

module.exports = gitOffline
// There is only one use-case for this: a local filesystem git repo cloned from
// a remote by the legacy version (fetch-git).
// The goal is to produce a clean tarball of a specific commit from the repo,
// so the new version of offliner can treat it the same as a product of the
// new version of download.js.
function gitOffline(spec, dlData, opts, next) {
  const GITPATH = opts.git || gitContext.gitPath
  if (!GITPATH) {
    const err = new Error('No git binary found in $PATH')
    err.code = 'ENOGIT'
    return next(err)
  }

  const dlRepoDir = 'file://' + path.join(
    npm.dlTracker.path, gitContext.dirNames.remotes, dlData.repoID
  )
  const tmpDir = path.join(npm.tmp, gitContext.dirNames.offlineTemps, dlData.repoID)
  gitAux.resolve(dlRepoDir, spec, spec.name, opts)
  .then(ref => {
    const tmpPkgDir = path.join(tmpDir, 'package')
    mkdirp(tmpPkgDir).then(() => {
      return shallowClone(dlRepoDir, ref.ref, tmpPkgDir, opts)
      // NOTE: the above promise resolves to the HEAD sha, but we don't need it here
      .then(() => {
        return packGitDep(spec, tmpPkgDir)
      })
    }).catch(err => {
      if (err.code == 'EEXIST') {
        const tmpTarPath = path.join(tmpDir, 'package.tgz')
        return statAsync(tmpTarPath).then(stat => {
          if (!stat.isFile())
            throw new Error("False package.tgz obstructing packaging of git repo")
          return tmpTarPath
        })
      }
      throw err
    }).then(tmpTarPath => next(null, npa(tmpTarPath)))
  })
  .catch(err => next(err))
}

// Extracted from pacote/lib/util/git.js, with some expansion mods
function shallowClone(repo, branch, target, opts) {
  const gitTemplateDir = path.join(
    npm.dlTracker.path, gitContext.dirNames.remotes, gitContext.dirNames.template
  )
  const gitArgs = [
    'clone', '--depth=1', '-q', // the original arg set
    '--no-hardlinks', `--template="${gitTemplateDir}"` // offliner additions
    // TODO: with "file://" as the prefix of repo already, I don't think the
    // '--no-hardlinks' option is needed anymore. TEST to verify.
  ]
  if (branch) {
    gitArgs.push('-b', branch)
  }
  gitArgs.push(repo, target)
  if (process.platform === 'win32') {
    gitArgs.push('--config', 'core.longpaths=true')
  }
  return execGit(gitArgs, { cwd: target }, opts)
  .then(() => {
    //return updateSubmodules(target, opts)
    const gitArgs = ['submodule', 'update', '-q', '--init', '--recursive']
    return execGit(gitArgs, { cwd: target }, opts)
  }).then(() => {
    //call to headSha(target, opts) translates as...
    const gitArgs = ['rev-parse', '--revs-only', 'HEAD']
    return execGit(gitArgs, { cwd: target }, opts).spread(stdout => {
      return stdout.trim()
    })
  })
}

function execGit(gitArgs, gitOpts, opts) {
  return BB.resolve(opts.git || gitContext.gitPath).then(gitPath => {
    return execFileAsync(gitPath, gitArgs, gitContext.mkOpts(gitOpts, opts))
  })
}

// Extracted from npm/lib/pack.js:
function packGitDep(spec, dir) {
  // Stream removed in this copy of the function.
  // Tarball path will be passed to pacote.manifest in fetchMetadata.
  let pkgJson
  return readJson(path.join(dir, 'package.json')).then((pkg) => {
    pkgJson = pkg
    if (pkgJson.scripts && pkgJson.scripts.prepare) {
      if (checkRepoDevDeps(pkgJson)) {
        return prepRawModule(pkgJson, dir, spec)
      }
    }
  }).then(() => {
    // Put the tarball next to the directory it archives
    const tmpTar = path.join(path.dirname(dir), 'package.tgz')
    return packDirectory(pkgJson, dir, tmpTar).then(() => {
      return tmpTar
    })
  })
}

function checkRepoDevDeps(pkgJson) {
  const thisFuncName = 'checkRepoDevDeps'
  const devDeps = pkgJson.devDependencies
  let problems = 0
  for (let pkgName in devDeps) {
    const specStr = `${pkgName}@${devDeps[pkgName]}`
    let dep, dlTrackerType
    try {
      dep = npa(pkgName, devDeps[pkgName])
    } catch (er) {
      ++problems
      log.warn(
        thisFuncName,
        `could not parse devDependency ${specStr}`
      )
      continue
    }
    dlTrackerType = DlTracker.typeMap[dep.type]
    if (!dlTrackerType) {
      ++problems
      log.warn(
        thisFuncName,
        `don't recognize type '${dep.type}' of devDependency ${specStr}`
      )
      continue
    }

    if (!npm.dlTracker.contains(dlTrackerType, pkgName, devDeps[pkgName])) {
      ++problems
      log.warn(thisFuncName, `devDependency ${specStr} not present`)
    }
  }
  if (problems) {
    const warnMsg = [
      `The package ${pkgJson.name}@${pkgJson.version} has a 'prepare' script `,
      'which indicates that it must be processed before installation; however, ',
      'there ',
      problems < 2 ? 'was a problem with one' : 'were problems with some',
      ' of its devDependencies, so the script was not run.\n',
      'The referenced package will be installed anyway, but it is possible ',
      'that your application will be unusable until you address the problems ',
      'and then run the prepare script manually.'
    ].join('')
    log.warn(thisFuncName, warnMsg)
  }
  return !!problems
}

// Here, target is full path of package.tgz.
// Note that original packGitDep does not pass anything for filename.
function packDirectory(pkgJson, dir, target, filename) {
  return lifecycle(pkgJson, 'prepack', dir)
  .then(() => {
    const tarOpt = {
      file: target,
      cwd: dir,
      prefix: 'package/',
      portable: true,
      // Provide a specific date in the 1980s for the benefit of zip,
      // which is confounded by files dated at the Unix epoch 0.
      mtime: new Date('1985-10-26T08:15:00.000Z'),
      gzip: true
    }

    return BB.resolve(packlist({ path: dir }))
    // NOTE: node-tar does some Magic Stuff depending on prefixes for files
    //       specifically with @ signs, so we just neutralize that one
    //       and any such future "features" by prepending `./`
      .then((files) => tar.create(tarOpt, files.map((f) => `./${f}`)))
      // <MMR> The following innocuous-looking call actually does something
      // critical and not-at-all obvious from the function name: it verifies
      // that (a) each item in the tarball corresponds to an existing file in
      // the directory it was made from, and (b) the sha checksum matches.
      // Note: pack.js packGitDep does nothing with the resolve() value here.
      .then(() => getContents(pkgJson, target, filename))
      // thread the content info through
      .tap(() => lifecycle(pkgJson, 'postpack', dir))
  })
}

