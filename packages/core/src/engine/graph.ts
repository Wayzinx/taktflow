import type { NodeDef, PlannedItem, PlannerNodeDef } from '../types.js'
import { assertNodeId } from '../store/paths.js'

export interface Entry { def: NodeDef; parent?: string; scope: string; item?: PlannedItem; iteration?: number }
export type Graph = Map<string, Entry>

export function validateDependencies(nodes: Array<{ id: string; needs?: string[] }>): void {
  const map = new Map(nodes.map((node) => [node.id, node]))
  if (map.size !== nodes.length) throw new Error('重复节点 / duplicate key')
  const visited = new Set<string>()
  const visiting = new Set<string>()
  function visit(id: string): void {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`依赖环 cycle: ${id}`)
    const node = map.get(id)
    if (!node) throw new Error(`未知依赖 unknown dependency: ${id}`)
    visiting.add(id)
    for (const dep of node.needs ?? []) visit(dep)
    visiting.delete(id)
    visited.add(id)
  }
  nodes.forEach((node) => { assertNodeId(node.id); visit(node.id) })
}

export function validateDag(nodes: NodeDef[], stages?: Set<string>, scope = ''): void {
  validateDependencies(nodes)
  const map = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (stages && node.stage && !stages.has(node.stage)) throw new Error(`[${scope}] ${node.id} 的阶段未声明：${node.stage}`)
    if (node.kind === 'loop') {
      if (!Number.isInteger(node.maxIterations) || node.maxIterations < 1) throw new Error('maxIterations 必须是正整数')
      validateDag(node.body, stages, `${scope}/${node.id}`)
    }
    if (node.kind === 'planner' && (!Number.isInteger(node.maxItems) || node.maxItems < 1)) throw new Error('maxItems 必须是正整数')
    if (node.kind === 'review') {
      if (!node.reviewers.length) throw new Error('reviewers 不能为空')
      if (!Number.isInteger(node.maxRounds) || node.maxRounds < 1) throw new Error('maxRounds 必须是正整数')
      if (new Set(node.reviewers.map((reviewer) => reviewer.role)).size !== node.reviewers.length) throw new Error('同一评审的 reviewer.role 不能重复')
      if (typeof node.onExhausted === 'object') {
        const policy = node.onExhausted
        if (!Number.isInteger(policy.maxReworks ?? 1) || (policy.maxReworks ?? 1) < 0) throw new Error('maxReworks 必须是非负整数')
        const ancestors = new Set<string>()
        const visit = (id: string): void => { for (const dep of map.get(id)?.needs ?? []) if (!ancestors.has(dep)) { ancestors.add(dep); visit(dep) } }
        visit(node.id)
        if (!map.has(policy.rework) || !ancestors.has(policy.rework)) throw new Error(`rework 目标必须在同作用域上游：${policy.rework}`)
      }
    }
    if (node.kind === 'judge') {
      if (!map.has(node.target)) throw new Error(`判决目标不存在于同一作用域：${node.target}`)
      for (const target of Object.values(node.routes)) {
        if (target === 'human' || target === 'ignore') continue
        if (!map.get(target)?.needs?.includes(node.id)) throw new Error(`判决路由目标必须在同一作用域依赖本节点：${target}`)
      }
    }
  }
}

export function qualify(nodes: NodeDef[], prefix: string): NodeDef[] {
  validateDag(nodes)
  return nodes.map((node) => {
    const qualified = { ...node, id: prefix + node.id, needs: (node.needs ?? []).map((id) => prefix + id) }
    if (qualified.kind === 'review' && typeof qualified.onExhausted === 'object') {
      qualified.onExhausted = { ...qualified.onExhausted, rework: prefix + qualified.onExhausted.rework }
    }
    return qualified
  })
}

export function expandPlanner(node: PlannerNodeDef, items: PlannedItem[]): Array<{ nodes: NodeDef[]; item: PlannedItem; scope: string }> {
  if (items.length > node.maxItems) throw new Error(`planner items 超过 maxItems=${node.maxItems}`)
  for (const item of items) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.key)) throw new Error(`非法 item key: ${item.key}`)
    if (item.role !== undefined && node.allowedRoles !== undefined && !node.allowedRoles.includes(item.role)) throw new Error(`role 不在 allowedRoles: ${item.role}`)
  }
  validateDependencies(items.map((item) => ({ id: item.key, needs: item.dependsOn })))
  const groups = items.map((item) => {
    const scope = `${node.id}/${item.key}/`
    return { nodes: qualify(node.expand(item), scope), item, scope }
  })
  const exits = new Map(groups.map((group) => [group.item.key, group.nodes.filter((n) => !group.nodes.some((other) => other.needs?.includes(n.id))).map((n) => n.id)]))
  for (const group of groups) {
    for (const child of group.nodes) {
      if (!child.needs?.length) child.needs = (group.item.dependsOn ?? []).flatMap((key) => exits.get(key)!)
    }
  }
  validateDependencies(groups.flatMap((group) => group.nodes))
  return groups
}
