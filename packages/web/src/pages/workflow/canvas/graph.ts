import type { EditableNode, EditableWorkflow, NodeKind, WorkflowDiagnostic, WorkflowLayout } from '@taktflow/core'
import { allNodes, findNode, literalOf, needsOf } from '../../../api/workflow-edit'

/**
 * 编辑器画布的几何：每个阶段一条竖向泳道（宽 LANE_W，与 mock 的自动布局列宽一致）。
 * 布局里存的都是绝对坐标；loop 体内节点在 React Flow 里挂到 loop 分组下，渲染时换算成相对坐标。
 */
export const NW = 220
export const NH = 66
/** planner 卡片下方多一条"运行时展开"托盘。 */
export const PLANNER_TRAY = 30
export const LANE_X0 = 20
export const LANE_W = 280
export const LANE_INNER = 260
export const LANE_HEAD = 46
export const GROUP_PAD = 14
export const GROUP_HEAD = 44

export interface Stage {
  id: string
  title: string
}

export type Pos = { x: number; y: number }

export const nodeHeight = (kind: NodeKind) => (kind === 'planner' ? NH + PLANNER_TRAY : NH)

export function stagesOf(model: EditableWorkflow): Stage[] {
  return literalOf<Stage[]>(model.stages) ?? []
}

export const laneX = (i: number) => LANE_X0 + i * LANE_W

/** 按节点中心所在的列推出泳道序号。 */
export function laneIndexAt(x: number, count: number): number {
  const i = Math.floor((x - LANE_X0) / LANE_W)
  return Math.max(0, Math.min(count - 1, i))
}

/** 节点所属阶段：顶层节点读 stage，loop 体内节点跟随 loop。 */
export function stageOfNode(model: EditableWorkflow, id: string): string | undefined {
  const loc = findNode(model.nodes, id)
  if (!loc) return undefined
  return literalOf<string>(loc.node.props.stage) ?? (loc.parent ? literalOf<string>(loc.parent.props.stage) : undefined)
}

export function titleOf(node: EditableNode): { text: string; code: boolean } {
  const v = node.props.title
  if (v?.kind === 'code') return { text: v.code, code: true }
  return { text: literalOf<string>(v) || node.id, code: false }
}

/** 布局里缺位置的节点（新加的、远端改动带来的）放到所在泳道最下方；不写回服务端，直到被拖动。 */
export function resolvePositions(model: EditableWorkflow, layout: WorkflowLayout | undefined): Record<string, Pos> {
  const stages = stagesOf(model)
  const out: Record<string, Pos> = {}
  const bottom = new Map<number, number>()
  const nodes = allNodes(model.nodes)
  for (const n of nodes) {
    const p = layout?.nodes[n.id]
    if (!p) continue
    out[n.id] = p
    const lane = laneIndexAt(p.x + NW / 2, Math.max(stages.length, 1))
    bottom.set(lane, Math.max(bottom.get(lane) ?? 0, p.y + nodeHeight(n.kind)))
  }
  for (const n of nodes) {
    if (out[n.id]) continue
    const loc = findNode(model.nodes, n.id)!
    if (loc.parent && out[loc.parent.id]) {
      const sib = loc.parent.body!.filter((s) => out[s.id] && s.id !== n.id)
      const maxY = sib.reduce((m, s) => Math.max(m, out[s.id]!.y + nodeHeight(s.kind)), out[loc.parent.id]!.y + GROUP_HEAD - 20)
      out[n.id] = { x: out[loc.parent.id]!.x + GROUP_PAD, y: maxY + 24 }
      continue
    }
    const lane = Math.max(0, stages.findIndex((s) => s.id === stageOfNode(model, n.id)))
    const b = bottom.get(lane)
    const y = b === undefined ? LANE_HEAD + 14 : b + 44
    out[n.id] = { x: laneX(lane) + (LANE_INNER - NW) / 2, y }
    bottom.set(lane, y + nodeHeight(n.kind))
  }
  return out
}

export interface GroupBox extends Pos {
  w: number
  h: number
}

/** loop 分组框：包住循环体，框左上角不晚于 loop 自己存的位置。 */
export function loopBox(loop: EditableNode, pos: Record<string, Pos>): GroupBox {
  const own = pos[loop.id] ?? { x: 0, y: 0 }
  const kids = (loop.body ?? []).filter((k) => pos[k.id])
  if (!kids.length) return { ...own, w: NW + GROUP_PAD * 2, h: GROUP_HEAD + NH }
  const minX = Math.min(...kids.map((k) => pos[k.id]!.x)) - GROUP_PAD
  const minY = Math.min(...kids.map((k) => pos[k.id]!.y)) - GROUP_HEAD
  const maxX = Math.max(...kids.map((k) => pos[k.id]!.x + NW)) + GROUP_PAD
  const maxY = Math.max(...kids.map((k) => pos[k.id]!.y + nodeHeight(k.kind))) + GROUP_PAD
  const x = Math.min(own.x, minX)
  const y = Math.min(own.y, minY)
  return { x, y, w: maxX - x, h: maxY - y }
}

/** 全部内容的下沿，泳道高度据此撑开。 */
export function contentBottom(model: EditableWorkflow, pos: Record<string, Pos>): number {
  let y = 0
  for (const n of model.nodes) {
    const b = n.kind === 'loop' ? loopBox(n, pos) : { y: pos[n.id]?.y ?? 0, h: nodeHeight(n.kind) }
    y = Math.max(y, b.y + b.h)
  }
  return y
}

/** 依赖边（needs）只允许在同一容器内；加边前检查是否成环。 */
export function canConnect(model: EditableWorkflow, source: string, target: string): string | undefined {
  if (source === target) return '不能依赖自己'
  const s = findNode(model.nodes, source)
  const t = findNode(model.nodes, target)
  if (!s || !t) return '节点不存在'
  if (s.parent?.id !== t.parent?.id) return '依赖只能连在同一层（loop 体内只连体内节点）'
  if (needsOf(t.node).includes(source)) return '已经存在这条依赖'
  if (dependsOn(model, source, target)) return `会形成环：${source} 已经（间接）依赖 ${target}`
  return undefined
}

/** a 是否（间接）依赖 b。 */
export function dependsOn(model: EditableWorkflow, a: string, b: string): boolean {
  const seen = new Set<string>()
  const stack = [a]
  while (stack.length) {
    const id = stack.pop()!
    if (id === b) return true
    if (seen.has(id)) continue
    seen.add(id)
    const n = findNode(model.nodes, id)
    if (n) stack.push(...needsOf(n.node))
  }
  return false
}

export function diagnosticsByNode(diags: WorkflowDiagnostic[] | undefined): Map<string, WorkflowDiagnostic[]> {
  const m = new Map<string, WorkflowDiagnostic[]>()
  for (const d of diags ?? []) if (d.nodeId) m.set(d.nodeId, [...(m.get(d.nodeId) ?? []), d])
  return m
}

/** 新节点 id：kind-1、kind-2 …，跳过已用的。 */
export function freshId(model: EditableWorkflow, kind: string): string {
  const used = new Set(allNodes(model.nodes).map((n) => n.id))
  let i = 1
  while (used.has(`${kind}-${i}`)) i++
  return `${kind}-${i}`
}

/** 插入位置：同一容器里同阶段最后一个节点之后，源码里同阶段的节点保持相邻。 */
export function insertAfter(model: EditableWorkflow, stage: string | undefined, parent: string | undefined): string | undefined {
  const list = parent ? (findNode(model.nodes, parent)?.node.body ?? []) : model.nodes
  if (parent) return list[list.length - 1]?.id
  const same = list.filter((n) => literalOf<string>(n.props.stage) === stage)
  return same[same.length - 1]?.id
}
