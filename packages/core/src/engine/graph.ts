import type { NodeDef, PlannedItem, PlannerNodeDef } from '../types.js'
import { assertNodeId } from '../store/paths.js'

export interface Entry { def: NodeDef; parent?: string; scope: string; item?: PlannedItem; iteration?: number }
export type Graph = Map<string, Entry>

export function validateDag(nodes: Array<{ id: string; needs?: string[] }>): void {
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

export function qualify(nodes: NodeDef[], prefix: string): NodeDef[] {
  validateDag(nodes)
  return nodes.map((node) => ({ ...node, id: prefix + node.id, needs: (node.needs ?? []).map((id) => prefix + id) }))
}

export function expandPlanner(node: PlannerNodeDef, items: PlannedItem[]): Array<{ nodes: NodeDef[]; item: PlannedItem; scope: string }> {
  if (items.length > node.maxItems) throw new Error(`planner items 超过 maxItems=${node.maxItems}`)
  for (const item of items) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.key)) throw new Error(`非法 item key: ${item.key}`)
    if (item.role !== undefined && node.allowedRoles !== undefined && !node.allowedRoles.includes(item.role)) throw new Error(`role 不在 allowedRoles: ${item.role}`)
  }
  validateDag(items.map((item) => ({ id: item.key, needs: item.dependsOn })))
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
  validateDag(groups.flatMap((group) => group.nodes))
  return groups
}
