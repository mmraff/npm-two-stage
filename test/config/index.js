//const fs = require('fs')
const path = require('path')

const stagedNpmLibPath = [
  'test/staging/', (process.platform != 'win32' ? 'lib/' : ''),
  'node_modules/npm/lib/'
].join('')

const fileMap = {
  'utils_cmd-list_test.js': 'src/utils/cmd-list.js',
  'utils_config_definitions_test.js': 'test/tempAssets8/npm/lib/utils/config/definitions.js',
  'dl_npf_test.js': 'src/download/npm-package-filename.js',
  'dl_reconstruct-map_test.js': 'src/download/reconstruct-map.js',
  'dl_dltracker_test.js': 'src/download/dltracker.js',
  'dl_read-from-tarball_test.js': 'src/download/read-from-tarball.js',
  'dl_git-tracker-keys_test.js': 'src/download/git-tracker-keys.js',
  'dl_alt-git_test.js': 'test/tempAssets2/npm/lib/download/alt-git.js',
  'dl_item-agents_test.js': 'test/tempAssets1/npm/lib/download/item-agents.js',
  'download_test.js': 'test/tempAssets7/npm/lib/download.js',
  'ofl_alt-arborist_test.js': 'test/tempAssets3/npm/lib/offliner/alt-arborist.js',
  'build-ideal-tree_test.js': 'test/tempAssets4/npm/lib/offliner/build-ideal-tree.js',
  'reify_test.js': 'test/tempAssets5/npm/lib/offliner/reify.js',
  'install_test.js': 'test/tempAssets6/npm/lib/install.js',
  'integration.js': [
    'download.js', 'install.js', 'download/config.js', 'download/dltracker.js',
    'download/npm-package-filename.js', 'download/reconstruct-map.js',
    'download/alt-git.js', 'download/git-tracker-keys.js',
    'download/item-agents.js', 'offliner/alt-arborist.js',
    'offliner/build-ideal-tree.js', 'offliner/reify.js'
  ].map(f => stagedNpmLibPath + f)
}

const TESTDIR_PREFIX_RE = new RegExp('^test\/')

module.exports = arg => {
  //fs.writeFileSync('coverage-map-input.txt', arg + '\n', { flag: 'as' })
  const key = arg.replace(TESTDIR_PREFIX_RE, '')
  return fileMap[key] || null
}

