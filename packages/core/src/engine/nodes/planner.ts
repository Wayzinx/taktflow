import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'
import type { AgentNodeDef, NodeDef, PlannedItem } from '../../types.js'
import { expandPlanner } from '../graph.js'
import { snapshotWorkflow } from '../../store/snapshot.js'
import { validateWorkflowHarnesses } from '../selection.js'
import { scopesOverlap } from '../fingerprint.js'
import { validateDependencies } from '../graph.js'
import { PLANNER_SCHEMA } from './schemas.js'

export async function run(host: NodeHost, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'planner') throw new Error('内部错误：不是 planner')
  const ns = host.state.nodes[node.id]!

  let expansion = host.state.expansions.find((item) => item.plannerId === node.id)
  if (!expansion) {
    const value = await host.model(entry, ctx, node.role, node.prompt, PLANNER_SCHEMA) as { items: PlannedItem[] }
    const groups = expandPlanner(node, value.items)
    for (const message of serializePlannerGroups(groups)) await host.emit('log', { level: 'info', message }, node.id)
    const definitions = groups.flatMap((group) => group.nodes)
    const workflow = { id: node.id, title: node.title, version: '1', stages: [], nodes: definitions }
    validateWorkflowHarnesses(workflow, { config: host.deps.stores.config, profiles: host.deps.profiles, harnesses: host.deps.harnesses }, host.override)
    const ids = groups.flatMap((group) => group.nodes.map((child) => child.id))
    if (ids.some((id) => host.graph.has(id))) throw new Error('planner 展开节点 ID 冲突')
    for (const group of groups) host.add(group.nodes, node.id, group.scope, group.item, entry.iteration)
    expansion = { plannerId: node.id, items: value.items, nodeIds: ids, nodes: snapshotWorkflow(workflow).nodes, at: host.timestamp() }
    host.state.expansions.push(expansion)
    await host.persistGraph()
    await host.emit('dag.expanded', expansion, node.id)
  }
  await host.schedule(expansion.nodeIds)
  host.containerState(ns, expansion.nodeIds)
  await host.save()

}

export function serializePlannerGroups(groups: ReturnType<typeof expandPlanner>): string[] {
  const messages: string[] = []
  const agents = (nodes: NodeDef[]): AgentNodeDef[] => nodes.flatMap((node): AgentNodeDef[] =>
    node.kind === 'agent' ? [node] : node.kind === 'loop' ? agents(node.body) : [])
  const reaches = (id: string, target: string, seen = new Set<string>()): boolean => {
    if (id === target) return true
    if (seen.has(id)) return false
    seen.add(id)
    return (groups.flatMap((group) => group.nodes).find((node) => node.id === id)?.needs ?? []).some((dep) => reaches(dep, target, seen))
  }
  for (let later = 1; later < groups.length; later++) for (let earlier = 0; earlier < later; earlier++) {
    const left = groups[earlier]!, right = groups[later]!
    const overlap = agents(left.nodes).some((a) => agents(right.nodes).some((b) =>
      a.repo === b.repo && scopesOverlap(a.writeScope ?? [], b.writeScope ?? [])))
    if (!overlap) continue
    // 已有逆向依赖已经确保串行；不要添加成环的反向边。
    if (left.nodes.some((a) => right.nodes.some((b) => reaches(a.id, b.id)))) continue
    const exits = left.nodes.filter((node) => !left.nodes.some((other) => other.needs?.includes(node.id))).map((node) => node.id)
    for (const node of right.nodes.filter((node) => !node.needs?.some((id) => right.nodes.some((other) => other.id === id)))) {
      node.needs = [...new Set([...(node.needs ?? []), ...exits])]
    }
    messages.push(`写权限相交，条目 ${right.item.key} 等待 ${left.item.key}，改为串行`)
  }
  validateDependencies(groups.flatMap((group) => group.nodes))
  return messages
}
