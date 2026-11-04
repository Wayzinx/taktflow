import type { ArtifactRef, NodeId, RunState } from '../types.js'

export function propagateStale(state: RunState, graph: Array<{ id: string; needs: string[]; parent?: string }>, cause: ArtifactRef): NodeId[] {
  const affected = new Set(Object.values(state.nodes).filter((node) => node.inputs?.some((input) =>
    input.workspace === cause.workspace && input.path === cause.path &&
    (cause.version === undefined || input.version === undefined || input.version < cause.version))).map((node) => node.id))
  let changed = true
  while (changed) {
    changed = false
    for (const node of graph) {
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
