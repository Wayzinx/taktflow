import type { ArtifactRef, NodeId, RunState, SnapshotNode } from '../types.js'

export function propagateStale(state: RunState, graph: Array<{ id: string; needs: string[]; parent?: string }>, cause: ArtifactRef): NodeId[] {
  // 新运行以 Expansion.nodes 为准；旧运行仍沿用调用方读到的 engine.json 记录。
  const definitions = new Map(graph.map((node) => [node.id, node]))
  const visit = (nodes: SnapshotNode[], parent: string, prefix = '') => {
    for (const node of nodes) {
      const id = prefix + node.id
      definitions.set(id, { id, parent, needs: node.needs.map((need) => prefix + need) })
      if (node.body) visit(node.body, id, `${id}/`)
    }
  }
  for (const expansion of state.expansions) if (expansion.nodes) visit(expansion.nodes, expansion.plannerId)
  const affected = new Set(Object.values(state.nodes).filter((node) => node.inputs?.some((input) =>
    input.workspace === cause.workspace && input.path === cause.path &&
    (cause.version === undefined || input.version === undefined || input.version < cause.version))).map((node) => node.id))
  let changed = true
  while (changed) {
    changed = false
    for (const node of definitions.values()) {
      if (affected.has(node.id) && node.parent && state.nodes[node.parent] && !affected.has(node.parent)) {
        affected.add(node.parent)
        changed = true
      }
      if (state.nodes[node.id] && !affected.has(node.id) && node.needs.some((id) => affected.has(id))) {
        affected.add(node.id)
        changed = true
      }
    }
  }
  return [...affected]
}
