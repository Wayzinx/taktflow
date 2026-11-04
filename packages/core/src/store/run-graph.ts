import path from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { NodeKind } from '../types.js'
import { buildRunGraph } from '../insights/graph.js'
import { readJsonFile } from './fs-utils.js'
import { assertNodeId, runDir } from './paths.js'

export type RunGraphNode = { id: string; needs: string[]; parent?: string; kind?: NodeKind; title?: string; role?: string; stage?: string; harness?: string }

export async function loadRunGraph(stores: ProjectStores, runId: string): Promise<RunGraphNode[]> {
  const file = path.join(runDir(stores.taktDir, runId), 'engine.json')
  const record = await readJsonFile<{ nodes?: RunGraphNode[] }>(file)
  const records = record?.nodes ?? []
  if (!Array.isArray(records) || records.some((node) => !node || typeof node.id !== 'string'
    || !Array.isArray(node.needs) || node.needs.some((id) => typeof id !== 'string')
    || (node.parent !== undefined && typeof node.parent !== 'string'))) throw new Error(`运行依赖记录不合法：${file}`)
  for (const node of records) {
    assertNodeId(node.id)
    node.needs.forEach(assertNodeId)
    if (node.parent) assertNodeId(node.parent)
  }
  const [snapshot, state] = await Promise.all([stores.runs.getWorkflow(runId), stores.runs.get(runId)])
  if (!snapshot || !state) return records
  const graph = buildRunGraph(snapshot, state, records)
  return graph.nodes.map(({ id, parent, kind, title, role, stage, harness }) => ({
    id, parent, kind, title, role, stage, harness,
    needs: graph.edges.filter((edge) => edge.kind === 'dep' && edge.to === id).map((edge) => edge.from),
  }))
}
