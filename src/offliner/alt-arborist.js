/*
  AltArborist: Arborist modified for offline stage of npm-two-stage.
  See @npmcli/arborist/lib/arborist/index.js for explanatory header.
*/

const {resolve} = require('path')
const {homedir} = require('os')
const procLog = require('proc-log')
const { saveTypeMap } = require('@npmcli/arborist/lib/add-rm-pkg-deps.js')

const mixins = [
  require('@npmcli/arborist/lib/tracker.js'),
  require('@npmcli/arborist/lib/arborist/pruner.js'),
  require('@npmcli/arborist/lib/arborist/deduper.js'),
  require('@npmcli/arborist/lib/arborist/audit.js'),
  require('./build-ideal-tree.js'),
  require('@npmcli/arborist/lib/arborist/load-workspaces.js'),
  require('@npmcli/arborist/lib/arborist/load-actual.js'),
  require('@npmcli/arborist/lib/arborist/load-virtual.js'),
  require('@npmcli/arborist/lib/arborist/rebuild.js'),
  require('./reify.js'),
]

const Base = mixins.reduce((a, b) => b(a), require('events'))
const getWorkspaceNodes = require('@npmcli/arborist/lib/get-workspace-nodes.js')

class AltArborist extends Base {
  constructor (options = {}) {
    process.emit('time', 'alt-arborist:ctor')
    super(options)
    this.options = {
      nodeVersion: process.version,
      ...options,
      path: options.path || '.',
      cache: options.cache || `${homedir()}/.npm/_cacache`,
      packumentCache: options.packumentCache || new Map(),
      log: options.log || procLog,
    }
    if (options.saveType && !saveTypeMap.get(options.saveType)) {
      throw new Error(`Invalid saveType ${options.saveType}`)
    }
    this.cache = resolve(this.options.cache)
    this.path = resolve(this.options.path)
    process.emit('timeEnd', 'alt-arborist:ctor')
  }

  // returns an array of the actual nodes for all the workspaces
  workspaceNodes (tree, workspaces) {
    return getWorkspaceNodes(tree, workspaces, this.log)
  }

  // returns a set of workspace nodes and all their deps
  workspaceDependencySet (tree, workspaces) {
    const wsNodes = this.workspaceNodes(tree, workspaces)
    const set = new Set(wsNodes)
    const extraneous = new Set()
    for (const node of set) {
      for (const edge of node.edgesOut.values()) {
        const dep = edge.to
        if (dep) {
          set.add(dep)
          if (dep.isLink) {
            set.add(dep.target)
          }
        }
      }
      for (const child of node.children.values()) {
        if (child.extraneous) {
          extraneous.add(child)
        }
      }
    }
    for (const extra of extraneous) {
      set.add(extra)
    }
    return set
  }
}

module.exports = AltArborist
