const path = require('path')
const { promisify } = require('util')

const rimrafAsync = promisify(require('rimraf'))
const tap = require('tap')

const makeAssets = require('./lib/make-assets')

const expectedPrototypes = [
  'AltArborist',
  'Reifier',
  'Builder',
  'VirtualLoader',
  'ActualLoader',
  'MapWorkspaces',
  'IdealTreeBuilder',
  'Auditor',
  'Deduper',
  'Pruner',
  'Tracker',
  'EventEmitter'
]

class dummyNode {
  constructor () {
    this.edgesOut = {
      values: function() { return this.edges },
      edges: []
    }
    this.children = {
      values: function() { return this.nodes },
      nodes: []
    }
  }
}

const testRootName = 'tempAssets3'
let n2sAssets
let AltArborist
let arbLibPath
let mockGetWSNodes

tap.before(() =>
  makeAssets(testRootName, 'offliner/alt-arborist.js', { offliner: true })
  .then(assets => {
    n2sAssets = assets
    AltArborist = require(assets.libOffliner + '/alt-arborist')
    arbLibPath = assets.nodeModules + '/@npmcli/arborist/lib'
    mockGetWSNodes = require(arbLibPath + '/get-workspace-nodes')
  })
)
tap.teardown(() => rimrafAsync(path.join(__dirname, testRootName)))

tap.test('AltArborist', t1 => {
  t1.throws(() => { new AltArborist({ saveType: 'noSuchSaveType' }) })

  const arb = new AltArborist()
  let proto = Object.getPrototypeOf(arb)
  for (let i = 0; i < expectedPrototypes.length; ++i) {
    t1.equal(proto.constructor.name, expectedPrototypes[i])
    proto = Object.getPrototypeOf(proto)
  }

  t1.test('workspaceDependencySet', t2 => {
    const dummyTree = { workspaces: [] }
    const testWSDepsData = []
    const node1 = new dummyNode()
    const node2 = new dummyNode()
    const node3 = new dummyNode()
    const node4 = new dummyNode()
    node2.isLink = true
    node2.target = node3
    node1.edgesOut.edges.push({ to: node2 }, { to: node4 }, {})
    node1.children.nodes.push({ extraneous: true }, {})
    testWSDepsData.push(node1)
    mockGetWSNodes.setTestConfig(testWSDepsData)
    t2.doesNotThrow(() => arb.workspaceDependencySet(dummyTree, {}))
    t2.end()
  })
  t1.end()
})
