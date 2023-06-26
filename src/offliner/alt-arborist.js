/*
  AltArborist: Arborist modified for offline stage of npm-two-stage.
  See @npmcli/arborist/lib/arborist/index.js for explanatory header.
*/

const { resolve } = require('path')
const { homedir } = require('os')
const { depth } = require('treeverse')
const { saveTypeMap } = require('@npmcli/arborist/lib/add-rm-pkg-deps.js')

const mixins = [
  require('@npmcli/arborist/lib/tracker.js'),
  require('@npmcli/arborist/lib/arborist/pruner.js'),
  require('@npmcli/arborist/lib/arborist/deduper.js'),
  require('@npmcli/arborist/lib/arborist/audit.js'),
  require('./build-ideal-tree.js'),
  require('@npmcli/arborist/lib/arborist/set-workspaces.js'),
  require('@npmcli/arborist/lib/arborist/load-actual.js'),
  require('@npmcli/arborist/lib/arborist/load-virtual.js'),
  require('@npmcli/arborist/lib/arborist/rebuild.js'),
  require('./reify.js'),
  require('@npmcli/arborist/lib/arborist/isolated-reifier.js'),
]

const _workspacesEnabled = Symbol.for('workspacesEnabled')
const Base = mixins.reduce((a, b) => b(a), require('events'))
const getWorkspaceNodes = require('@npmcli/arborist/lib/get-workspace-nodes.js')

// if it's 1, 2, or 3, set it explicitly that.
// if undefined or null, set it null
// otherwise, throw.
const lockfileVersion = lfv => {
  if (lfv === 1 || lfv === 2 || lfv === 3) {
    return lfv
  }

  if (lfv === undefined || lfv === null) {
    return null
  }

  throw new TypeError('Invalid lockfileVersion config: ' + lfv)
}

class AltArborist extends Base {
  constructor (options = {}) {
    process.emit('time', 'alt-arborist:ctor')
    super(options)
    this.options = {
      nodeVersion: process.version,
      ...options,
      Arborist: this.constructor,
      path: options.path || '.',
      cache: options.cache || `${homedir()}/.npm/_cacache`,
      packumentCache: options.packumentCache || new Map(),
      workspacesEnabled: options.workspacesEnabled !== false,
      replaceRegistryHost: options.replaceRegistryHost,
      lockfileVersion: lockfileVersion(options.lockfileVersion),
      installStrategy: options.global ? 'shallow' : (options.installStrategy ? options.installStrategy : 'hoisted'),
    }
    this.replaceRegistryHost = this.options.replaceRegistryHost =
      (!this.options.replaceRegistryHost || this.options.replaceRegistryHost === 'npmjs') ?
        'registry.npmjs.org' : this.options.replaceRegistryHost

    this[_workspacesEnabled] = this.options.workspacesEnabled

    if (options.saveType && !saveTypeMap.get(options.saveType)) {
      throw new Error(`Invalid saveType ${options.saveType}`)
    }
    this.cache = resolve(this.options.cache)
    this.path = resolve(this.options.path)
    process.emit('timeEnd', 'alt-arborist:ctor')
  }

  // TODO: We should change these to static functions instead
  //   of methods for the next major version

  // returns an array of the actual nodes for all the workspaces
  workspaceNodes (tree, workspaces) {
    return getWorkspaceNodes(tree, workspaces)
  }

  // returns a set of workspace nodes and all their deps
  workspaceDependencySet (tree, workspaces, includeWorkspaceRoot) {
    const wsNodes = this.workspaceNodes(tree, workspaces)
    if (includeWorkspaceRoot) {
      for (const edge of tree.edgesOut.values()) {
        if (edge.type !== 'workspace' && edge.to) {
          wsNodes.push(edge.to)
        }
      }
    }
    const wsDepSet = new Set(wsNodes)
    const extraneous = new Set()
    for (const node of wsDepSet) {
      for (const edge of node.edgesOut.values()) {
        const dep = edge.to
        if (dep) {
          wsDepSet.add(dep)
          if (dep.isLink) {
            wsDepSet.add(dep.target)
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
      wsDepSet.add(extra)
    }

    return wsDepSet
  }

  // returns a set of root dependencies, excluding dependencies that are
  // exclusively workspace dependencies
  excludeWorkspacesDependencySet (tree) {
    const rootDepSet = new Set()
    depth({
      tree,
      visit: node => {
        for (const { to } of node.edgesOut.values()) {
          if (!to || to.isWorkspace) {
            continue
          }
          for (const edgeIn of to.edgesIn.values()) {
            if (edgeIn.from.isRoot || rootDepSet.has(edgeIn.from)) {
              rootDepSet.add(to)
            }
          }
        }
        return node
      },
      filter: node => node,
      getChildren: (node, tree) =>
        [...tree.edgesOut.values()].map(edge => edge.to),
    })
    return rootDepSet
  }
}

module.exports = AltArborist
