import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'
import type { PlannedItem } from '../../types.js'
import { expandPlanner } from '../graph.js'
import { PLANNER_SCHEMA } from './schemas.js'

export async function run(host: NodeHost, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'planner') throw new Error('内部错误：不是 planner')
  const ns = host.state.nodes[node.id]!

  let expansion = host.state.expansions.find((item) => item.plannerId === node.id)
  if (!expansion) {
    const value = await host.model(entry, ctx, node.role, node.prompt, PLANNER_SCHEMA) as { items: PlannedItem[] }
    const groups = expandPlanner(node, value.items)
    const ids = groups.flatMap((group) => group.nodes.map((child) => child.id))
    if (ids.some((id) => host.graph.has(id))) throw new Error('planner 展开节点 ID 冲突')
    for (const group of groups) host.add(group.nodes, node.id, group.scope, group.item, entry.iteration)
    expansion = { plannerId: node.id, items: value.items, nodeIds: ids, at: host.timestamp() }
    host.state.expansions.push(expansion)
    await host.persistGraph()
    await host.emit('dag.expanded', expansion, node.id)
  }
  await host.schedule(expansion.nodeIds)
  host.containerState(ns, expansion.nodeIds)
  await host.save()

}
