import { buildRunGraph, type Actor, type ArtifactRef, type ProjectStores } from '@taktflow/core'
import { workflow } from './read-model.js'

const writes = new Map<string, Promise<unknown>>()

// 同一进程的多个 HTTP 服务也共享队列；跨进程协调需由 core 提供原子更新协议。
export async function serialize<T>(projectDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(projectDir) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  const tail = current.catch(() => {})
  writes.set(projectDir, tail)
  try { return await current } finally { if (writes.get(projectDir) === tail) writes.delete(projectDir) }
}

export async function markStale(stores: ProjectStores, cause: ArtifactRef, actor: Actor): Promise<Array<{ runId: string; nodeId: string }>> {
  const affected: Array<{ runId: string; nodeId: string }> = []
  for (const item of await stores.runs.list({ requirementId: cause.workspace })) {
    const state = await stores.runs.get(item.runId)
    if (!state) continue
    const graph = buildRunGraph(await workflow(stores, state.runId), state)
    const edges = new Map<string, Set<string>>()
    const edge = (from: string, to: string) => {
      if (!edges.has(from)) edges.set(from, new Set())
      edges.get(from)!.add(to)
    }
    for (const { from, to } of graph.edges) edge(from, to)
    for (const node of graph.nodes) {
      if (!node.parent) continue
      // 容器需要重新执行；动态组缺少 needs 快照，保守地让整个组失效。
      edge(node.id, node.parent)
      edge(node.parent, node.id)
    }
    for (const consumer of Object.values(state.nodes)) {
      for (const producer of Object.values(state.nodes)) {
        if (producer.id === consumer.id) continue
        if (consumer.inputs?.some((input) => producer.outputs.some((output) => output.workspace === input.workspace && output.path === input.path && (input.version === undefined || output.version === undefined || input.version === output.version)))) edge(producer.id, consumer.id)
      }
    }
    const pending = Object.values(state.nodes).filter((node) => node.inputs?.some((input) => input.workspace === cause.workspace && input.path === cause.path)).map((node) => node.id)
    const seen = new Set<string>()
    while (pending.length) {
      const id = pending.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      pending.push(...(edges.get(id) ?? []))
    }
    const changed = [...seen].filter((id) => Object.hasOwn(state.nodes, id))
    if (!changed.length) continue
    for (const id of changed) state.nodes[id]!.status = 'stale'
    await stores.runs.save(state)
    for (const nodeId of changed) {
      await stores.events.append(state.runId, { type: 'node.stale', nodeId, actor, data: { cause } })
      affected.push({ runId: state.runId, nodeId })
    }
  }
  return affected
}
