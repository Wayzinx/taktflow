import type { ArtifactRecord, ArtifactRef, TraceGraph, TraceNodeType } from '../types.js'
import type { ArtifactData } from './artifacts.js'

type TraceNode = TraceGraph['nodes'][number]
type TraceEdge = TraceGraph['edges'][number]

const artifactId = (ref: ArtifactRef) => `artifact:${encodeURIComponent(ref.workspace)}:${encodeURIComponent(ref.path)}@${ref.version ?? 'latest'}`
const latestVersion = (artifact: ArtifactRecord) => artifact.versions.reduce<number | undefined>((latest, version) => Math.max(latest ?? 0, version.version), undefined)

function artifactType(artifact: ArtifactRecord): TraceNodeType {
  if (artifact.kind === 'case' || artifact.kind === 'task' || artifact.kind === 'evidence' || artifact.kind === 'verdict') return artifact.kind
  return artifact.kind === 'code-change' ? 'code' : 'artifact'
}

export function buildTraceGraph(requirementId: string, title: string, data: ArtifactData): TraceGraph {
  const nodes = new Map<string, TraceNode>()
  const edges = new Map<string, TraceEdge>()
  const addNode = (node: TraceNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node)
    return node.id
  }
  const addEdge = (from: string, to: string, rel: TraceEdge['rel']) => {
    const edge = { from, to, rel }
    edges.set(JSON.stringify(edge), edge)
  }
  const records = new Map(data.artifacts.map((artifact) => [artifact.path, artifact]))
  const ensureArtifact = (reference: ArtifactRef): string => {
    const record = reference.workspace === requirementId ? records.get(reference.path) : undefined
    const ref = { ...reference, version: reference.version ?? (record ? latestVersion(record) : undefined) }
    return addNode({
      id: artifactId(ref), type: record ? artifactType(record) : 'artifact', ref,
      label: `${record?.title ?? ref.path}${ref.version === undefined ? '（版本未解析）' : ` · v${ref.version}`}`,
    })
  }
  const ensureAc = (ac: string) => {
    const id = addNode({ id: ac, type: 'ac', label: data.acs.get(ac) ?? ac })
    if (data.acs.has(ac)) addEdge(requirementId, id, 'derives')
    return id
  }
  const ensureCase = (id: string, label?: string) => addNode({ id, type: 'case', label: label ?? id, status: data.results.get(id) })
  addNode({ id: requirementId, type: 'requirement', label: title })
  for (const ac of data.acs.keys()) ensureAc(ac)
  for (const testCase of data.cases) {
    const id = ensureCase(testCase.id, testCase.title)
    const artifact = ensureArtifact({ workspace: requirementId, path: testCase.path })
    addEdge(artifact, id, 'derives')
    for (const ac of testCase.covers) addEdge(id, ensureAc(ac), 'covers')
  }
  for (const artifact of data.artifacts) {
    const currentId = ensureArtifact({ workspace: requirementId, path: artifact.path })
    for (const version of artifact.versions) {
      const target = ensureArtifact({ workspace: requirementId, path: artifact.path, version: version.version })
      for (const source of version.derivedFrom) addEdge(ensureArtifact(source), target, 'derives')
      if (version.producedBy) {
        const { runId, nodeId } = version.producedBy
        const producer = addNode({ id: `run-node:${encodeURIComponent(runId)}:${encodeURIComponent(nodeId)}`, type: 'run-node', label: `${runId} / ${nodeId}` })
        addEdge(producer, target, 'produced')
      }
    }
    // traceIds 属于当前 ArtifactRecord，不能把它们冒充为每个历史版本的内容。
    for (const traceId of artifact.traceIds) {
      if (/^AC-\d+(?:-\d+)?$/.test(traceId)) {
        const ac = ensureAc(traceId)
        if (artifact.kind === 'spec') addEdge(currentId, ac, 'derives')
        if (artifact.kind === 'task' || artifact.kind === 'code-change') addEdge(currentId, ac, 'implements')
      } else if (/^TC-[A-Z0-9-]+$/.test(traceId)) {
        const testCase = ensureCase(traceId)
        if (artifact.kind === 'verdict') addEdge(currentId, testCase, 'judged')
      }
    }
    const evidenceCase = /^evidence\/([^/]+)\//.exec(artifact.path)?.[1]
    if (evidenceCase) addEdge(currentId, ensureCase(evidenceCase), 'verifies')
  }
  const summary = records.get('evidence/summary.json')
  if (summary) {
    const summaryId = ensureArtifact({ workspace: requirementId, path: summary.path })
    for (const id of data.results.keys()) addEdge(summaryId, ensureCase(id), 'verifies')
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}
