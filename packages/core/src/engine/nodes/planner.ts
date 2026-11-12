import { scheduleCheckpoint, finishCheckpoint, withCapture } from '../checkpoints.js'
import type { NodeContext } from '../../types.js'
import type { Entry } from '../graph.js'
import type { NodeHost } from './host.js'
import type { AgentNodeDef, AgentProfile, NodeDef, PlannedItem } from '../../types.js'
import { expandPlanner } from '../graph.js'
import { snapshotWorkflow } from '../../store/snapshot.js'
import { validateWorkflowHarnesses } from '../selection.js'
import { intersectWriteScopes } from '../scope.js'
import { scopesOverlap } from '../fingerprint.js'
import { validateDependencies } from '../graph.js'
import { PLANNER_SCHEMA } from './schemas.js'
import { matchGlob } from '../../util/glob.js'

export async function run(host: NodeHost, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'planner') throw new Error('内部错误：不是 planner')
  const ns = host.state.nodes[node.id]!

  let expansion = host.state.expansions.find((item) => item.plannerId === node.id)
  if (!expansion) {
    const point = await scheduleCheckpoint(host, node.id, 'planner', node.role, [node.title])
    let value: { items: PlannedItem[] }
    try {
      value = await withCapture(host, node.id, { role: 'planner', checkpointId: point.id }, () => host.model(entry, ctx, node.role, node.prompt, PLANNER_SCHEMA)) as { items: PlannedItem[] }
      const groups = expandPlanner(node, value.items)
      const outside = plannedScopeProblems(groups, host.deps.profiles)
      if (outside.length) throw new Error(`规划的条目要改的文件不在写权限里：${outside.join('；')}。改角色的写权限，或调整设计里的文件位置后重试这个节点`)
      for (const message of serializePlannerGroups(groups, host.deps.profiles)) await host.emit('log', { level: 'info', message }, node.id)
      const definitions = groups.flatMap((group) => group.nodes)
      const workflow = { id: node.id, title: node.title, version: '1', stages: [], nodes: definitions }
      validateWorkflowHarnesses(workflow, { config: host.deps.stores.config, profiles: host.deps.profiles, harnesses: host.deps.harnesses, bridge: host.deps.bridge }, host.override)
      const ids = groups.flatMap((group) => group.nodes.map((child) => child.id))
      if (ids.some((id) => host.graph.has(id))) throw new Error('planner 展开节点 ID 冲突')
      for (const group of groups) host.add(group.nodes, node.id, group.scope, group.item, entry.iteration)
      expansion = { plannerId: node.id, items: value.items, nodeIds: ids, nodes: snapshotWorkflow(workflow).nodes, at: host.timestamp() }
      host.state.expansions.push(expansion)
      await host.persistGraph()
      await host.emit('dag.expanded', expansion, node.id)
      await finishCheckpoint(host, point, 'done')
    } catch (error) { await finishCheckpoint(host, point, 'error', error); throw error }
  }
  await host.schedule(expansion.nodeIds)
  host.containerState(ns, expansion.nodeIds)
  await host.save()

}

/**
 * 条目在 params.paths 里列了要改的文件时，展开前先和改代码节点（带 repo 的 agent）的写权限对一遍：
 * 对不上的实现必然被写权限守卫拦下，不如现在就失败，别等实现跑完。
 */
export function plannedScopeProblems(groups: ReturnType<typeof expandPlanner>, profiles: Record<string, AgentProfile> = {}): string[] {
  const problems: string[] = []
  for (const group of groups) {
    const paths = group.item.params?.paths
    if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) continue
    for (const child of group.nodes) {
      if (child.kind !== 'agent' || !child.repo || !profiles[child.role]) continue
      const scope = intersectWriteScopes(profiles[child.role]!.writeScope, child.writeScope)
      const outside = paths.filter((path) => !scope.some((pattern) => matchGlob(pattern, path)))
      if (outside.length) problems.push(`${group.item.key} 要改 ${outside.join('、')}，角色 ${child.role} 只能写 ${scope.join('、') || '（无）'}`)
    }
  }
  return problems
}

export function serializePlannerGroups(groups: ReturnType<typeof expandPlanner>, profiles: Record<string, AgentProfile> = {}): string[] {
  const messages: string[] = []
  const scope = (node: AgentNodeDef) => profiles[node.role] ? intersectWriteScopes(profiles[node.role]!.writeScope, node.writeScope) : node.writeScope
  const overlaps = (a: AgentNodeDef, b: AgentNodeDef) => {
    const left = scope(a), right = scope(b)
    return left === undefined || right === undefined || scopesOverlap(left, right)
  }
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
      a.repo === b.repo && overlaps(a, b)))
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
