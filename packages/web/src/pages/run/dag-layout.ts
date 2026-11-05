import { MarkerType, type Edge, type Node, type BuiltInEdge } from '@xyflow/react'
import type { FlowEdge } from './dag-edges'
import type { Expansion, GraphEdge, GraphNode, StageDef, StageProgress, Usage } from '@taktflow/core'
import { VERDICT } from '../../lib/status'
import { nodeLabel, type NodeLabel } from './node-label'

/**
 * DAG 布局（不依赖 dagre / elk）：
 * - 每个阶段一列，列头显示阶段名；列内按依赖拓扑排序、自上而下堆叠；
 * - loop 节点本身是分组框，循环体在框内按依赖分层（从左到右）；
 * - planner 的展开节点放进它右侧的虚线分组框，每个条目一行，行内按依赖、没有依赖时按展开顺序从左到右；
 * - 边的连接点按相对位置选：左右相邻走右→左，同列相邻走下→上，同列跨行走左侧括号。
 */

export const NW = 220
export const NH = 66
const GAP_Y = 18
const COL_GAP = 72
const PAD = 14
const HEAD = 42
const IN_GAP_X = 44
/** loop 体内 judge → 修复节点的路由边要挂类别标签，列间距留够标签宽度。 */
const LOOP_GAP_X = 88
const EXP_GAP = 52
export const LANE_HEAD = 46
const LANE_PAD_X = 18

export interface DagNodeData extends Record<string, unknown> {
  node: GraphNode
  label: NodeLabel
  /** 循环体内节点的轮次和所在 loop 一致时不再重复画角标（分组框头上已经有）。 */
  hideIteration?: boolean
  selected?: boolean
  dim?: boolean
}
export interface GroupData extends Record<string, unknown> {
  title: string
  variant: 'loop' | 'expand'
  node?: GraphNode
  childCount: number
  usage?: Usage
  items?: number
  selected?: boolean
}
export interface LaneData extends Record<string, unknown> {
  stage: StageProgress
  index: number
}

export type FlowNode = Node<DagNodeData, 'dag'> | Node<GroupData, 'group'> | Node<LaneData, 'lane'>

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function topoOrder(ids: string[], edges: GraphEdge[]): string[] {
  const set = new Set(ids)
  const indeg = new Map(ids.map((id) => [id, 0]))
  for (const e of edges) if (set.has(e.from) && set.has(e.to) && e.from !== e.to) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  const out: string[] = []
  const ready = ids.filter((id) => indeg.get(id) === 0)
  while (ready.length) {
    const id = ready.shift()!
    out.push(id)
    for (const e of edges) {
      if (e.from !== id || !set.has(e.to)) continue
      const d = (indeg.get(e.to) ?? 0) - 1
      indeg.set(e.to, d)
      if (d === 0) {
        // 保持原始顺序稳定
        const pos = ids.indexOf(e.to)
        const at = ready.findIndex((r) => ids.indexOf(r) > pos)
        ready.splice(at < 0 ? ready.length : at, 0, e.to)
      }
    }
  }
  for (const id of ids) if (!out.includes(id)) out.push(id)
  return out
}

function depthMap(ids: string[], edges: GraphEdge[]): Map<string, number> {
  const order = topoOrder(ids, edges)
  const set = new Set(ids)
  const depth = new Map(ids.map((id) => [id, 0]))
  for (const id of order) for (const e of edges) if (e.from === id && set.has(e.to)) depth.set(e.to, Math.max(depth.get(e.to)!, depth.get(id)! + 1))
  return depth
}

const sumUsage = (nodes: GraphNode[]): Usage | undefined =>
  nodes.reduce<Usage | undefined>((acc, n) => (n.usage ? { inputTokens: (acc?.inputTokens ?? 0) + n.usage.inputTokens, outputTokens: (acc?.outputTokens ?? 0) + n.usage.outputTokens, costUsd: (acc?.costUsd ?? 0) + (n.usage.costUsd ?? 0) } : acc), undefined)

export interface Layout {
  nodes: FlowNode[]
  edges: Edge[]
  /** 每个阶段包含的节点 id（聚焦视图用）。 */
  stageNodes: Map<string, string[]>
}

export function layoutRun(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, stageDefs: StageDef[], stages: StageProgress[], expansions: Expansion[], selected?: string): Layout {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const leaf = (n: GraphNode, extra: Partial<DagNodeData> = {}): DagNodeData => ({ node: n, label: nodeLabel(n, expansions), selected: n.id === selected, ...extra })
  const children = new Map<string, GraphNode[]>()
  for (const n of graph.nodes) if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n])
  const top = graph.nodes.filter((n) => !n.parent)

  const flow: FlowNode[] = []
  const lanes: FlowNode[] = []
  const groups: FlowNode[] = []
  const leaves: FlowNode[] = []
  const abs = new Map<string, Box>()
  const columnOf = new Map<string, number>()
  const itemIndex = new Map<string, number>()
  const stageNodes = new Map<string, string[]>()

  /** 分组框内部布局，返回框的尺寸；子节点坐标相对分组框。 */
  function layoutGroup(groupId: string, kids: GraphNode[], variant: 'loop' | 'expand'): { w: number; h: number; place: (gx: number, gy: number) => void } {
    const ids = kids.map((k) => k.id)
    const pos = new Map<string, { col: number; row: number }>()
    if (variant === 'expand') {
      // 每个条目一行：id 形如 <planner>/<itemKey>/<child>
      const rows = [...new Set(ids.map((id) => id.split('/').slice(-2, -1)[0] ?? id))]
      for (const row of rows) {
        const rowIds = ids.filter((id) => id.split('/').slice(-2, -1)[0] === row)
        // 展开节点之间常常没有显式依赖边，深度全是 0 会叠在一起；按拓扑序逐个排开
        topoOrder(rowIds, graph.edges).forEach((id, col) => pos.set(id, { col, row: rows.indexOf(row) }))
      }
    } else {
      const d = depthMap(ids, graph.edges)
      const perCol = new Map<number, number>()
      for (const id of topoOrder(ids, graph.edges)) {
        const col = d.get(id)!
        const row = perCol.get(col) ?? 0
        perCol.set(col, row + 1)
        pos.set(id, { col, row })
      }
    }
    const gapX = variant === 'loop' ? LOOP_GAP_X : IN_GAP_X
    const cols = Math.max(1, ...[...pos.values()].map((p) => p.col + 1))
    const rows = Math.max(1, ...[...pos.values()].map((p) => p.row + 1))
    const w = PAD * 2 + cols * NW + (cols - 1) * gapX
    const h = HEAD + rows * NH + (rows - 1) * GAP_Y + PAD
    return {
      w,
      h,
      place(gx, gy) {
        for (const k of kids) {
          const p = pos.get(k.id)!
          const rel = { x: PAD + p.col * (NW + gapX), y: HEAD + p.row * (NH + GAP_Y) }
          abs.set(k.id, { x: gx + rel.x, y: gy + rel.y, w: NW, h: NH })
          const parent = byId.get(k.parent ?? '')
          const hideIteration = variant === 'loop' && k.iteration === parent?.iteration
          leaves.push({ id: k.id, type: 'dag', parentId: groupId, extent: 'parent', position: rel, width: NW, height: NH, data: leaf(k, { hideIteration }), draggable: false, zIndex: 4 })
        }
      },
    }
  }

  const stageIds = [...stageDefs.map((s) => s.id)]
  if (top.some((n) => !n.stage || !stageIds.includes(n.stage))) stageIds.push('__other')
  let x = 0
  let maxH = 0
  const colBoxes: Array<{ x: number; w: number; stageId: string }> = []

  stageIds.forEach((stageId, ci) => {
    const items = top.filter((n) => (stageId === '__other' ? !n.stage || !stageDefs.some((s) => s.id === n.stage) : n.stage === stageId))
    const order = topoOrder(
      items.map((n) => n.id),
      graph.edges,
    )
    let y = 0
    let colW = NW
    const ids: string[] = []
    order.forEach((id, idx) => {
      const n = byId.get(id)!
      const kids = children.get(id) ?? []
      ids.push(id, ...kids.map((k) => k.id))
      columnOf.set(id, ci)
      itemIndex.set(id, idx)
      for (const k of kids) columnOf.set(k.id, ci)
      if (n.kind === 'loop' && kids.length) {
        const g = layoutGroup(id, kids, 'loop')
        abs.set(id, { x, y, w: g.w, h: g.h })
        groups.push({ id, type: 'group', position: { x, y }, width: g.w, height: g.h, style: { width: g.w, height: g.h }, data: { title: n.title, variant: 'loop', node: n, childCount: kids.length, usage: sumUsage(kids), selected: id === selected }, draggable: false, zIndex: 1 })
        g.place(x, y)
        colW = Math.max(colW, g.w)
        y += g.h + GAP_Y + 4
        return
      }
      if (n.kind === 'planner' && kids.length) {
        const gid = `__expand__/${id}`
        const g = layoutGroup(gid, kids, 'expand')
        const nodeY = y + HEAD - 2
        abs.set(id, { x, y: nodeY, w: NW, h: NH })
        leaves.push({ id, type: 'dag', position: { x, y: nodeY }, width: NW, height: NH, data: leaf(n), draggable: false, zIndex: 4 })
        const gx = x + NW + EXP_GAP
        abs.set(gid, { x: gx, y, w: g.w, h: g.h })
        const itemCount = new Set(kids.map((k) => k.id.split('/').slice(-2, -1)[0])).size
        groups.push({ id: gid, type: 'group', position: { x: gx, y }, width: g.w, height: g.h, style: { width: g.w, height: g.h }, data: { title: '动态展开', variant: 'expand', childCount: kids.length, items: itemCount, usage: sumUsage(kids) }, draggable: false, zIndex: 1 })
        g.place(gx, y)
        colW = Math.max(colW, NW + EXP_GAP + g.w)
        y += g.h + GAP_Y + 4
        return
      }
      abs.set(id, { x, y, w: NW, h: NH })
      leaves.push({ id, type: 'dag', position: { x, y }, width: NW, height: NH, data: leaf(n), draggable: false, zIndex: 4 })
      y += NH + GAP_Y
    })
    stageNodes.set(stageId, ids)
    colBoxes.push({ x, w: colW, stageId })
    maxH = Math.max(maxH, y - GAP_Y)
    x += colW + COL_GAP
  })

  colBoxes.forEach((c, i) => {
    const stage = stages.find((s) => s.id === c.stageId) ?? { id: c.stageId, title: '其他', status: 'todo' as const, done: 0, total: 0 }
    lanes.push({
      id: `__lane__/${c.stageId}`,
      type: 'lane',
      position: { x: c.x - LANE_PAD_X, y: -LANE_HEAD - 10 },
      width: c.w + LANE_PAD_X * 2,
      height: maxH + LANE_HEAD + 34,
      style: { width: c.w + LANE_PAD_X * 2, height: maxH + LANE_HEAD + 34 },
      data: { stage, index: i + 1 },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: 0,
    })
  })

  // ---------------------------------------------------------------- 边
  const routePairs = new Set(graph.edges.filter((e) => e.kind === 'route').map((e) => `${e.from}→${e.to}`))
  // planner → 每个展开节点各一条点线会横穿分组框里的节点；分组框已经表达了"这些是它展开的"，合成一条 planner → 分组框
  const expandedPlanners = new Set<string>()
  const drawn: GraphEdge[] = []
  for (const e of graph.edges) {
    if (e.kind === 'expand' && abs.has(`__expand__/${e.from}`)) {
      if (expandedPlanners.has(e.from)) continue
      expandedPlanners.add(e.from)
      drawn.push({ ...e, to: `__expand__/${e.from}` })
      continue
    }
    drawn.push(e)
  }
  const edges: (BuiltInEdge | FlowEdge)[] = []
  drawn.forEach((e, i) => {
    if (e.kind === 'dep' && routePairs.has(`${e.from}→${e.to}`)) return
    const s = abs.get(e.from)
    const t = abs.get(e.to)
    if (!s || !t) return
    let sourceHandle = 'r'
    let targetHandle = 'l'
    const overlapX = t.x < s.x + s.w && s.x < t.x + t.w
    if (t.x >= s.x + s.w - 4) {
      // 默认：右 → 左
    } else if (overlapX && t.y > s.y) {
      const sameCol = columnOf.get(e.from) === columnOf.get(e.to)
      const gap = Math.abs((itemIndex.get(e.to) ?? 0) - (itemIndex.get(e.from) ?? 0))
      if (sameCol && gap > 1 && itemIndex.has(e.from) && itemIndex.has(e.to)) {
        sourceHandle = 'ls'
      } else {
        sourceHandle = 'b'
        targetHandle = 't'
      }
    } else if (t.y > s.y) {
      sourceHandle = 'b'
      targetHandle = 't'
    }
    const target = byId.get(e.to)
    const source = byId.get(e.from)
    const inactive = target?.status === 'skipped' || target?.status === 'pending' || target?.status === 'cancelled'
    const live = target?.status === 'running' && (source?.status === 'succeeded' || source?.status === 'running')
    const color =
      e.kind === 'route'
        ? (VERDICT[e.label as keyof typeof VERDICT]?.color ?? 'var(--accent)')
        : e.kind === 'expand'
          ? 'var(--c-6)'
          : live
            ? 'var(--st-running)'
            : 'var(--edge)'
    const dash = e.kind === 'route' ? '6 4' : e.kind === 'expand' ? '1 5' : undefined
    const offset = sourceHandle === 'ls' ? 28 : sourceHandle === 'b' ? Math.max(4, Math.min(18, (t.y - s.y - s.h) / 2 - 2)) : 18
    // 数据正在流过（上游已产出、下游在跑）：换成带节拍光点的 flow 边；planner 展开线不算数据流
    const flowing = live && e.kind !== 'expand'
    const common = {
      id: `e${i}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      sourceHandle,
      targetHandle,
      label: e.kind === 'route' ? (VERDICT[e.label as keyof typeof VERDICT]?.label ?? e.label) : undefined,
      labelStyle: { fontSize: 11, fontWeight: 600, fill: color },
      labelBgStyle: { fill: 'var(--surface)', stroke: color, strokeOpacity: 0.35 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: e.kind === 'expand' ? undefined : { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: flowing ? 1.8 : e.kind === 'dep' ? 1.4 : 1.6, strokeDasharray: dash, strokeLinecap: 'round' as const, opacity: inactive ? 0.4 : 1 },
      zIndex: flowing ? 5 : 3,
      className: flowing ? 'is-flowing' : undefined,
    }
    // 上下相邻的 b → t 边间距很小，默认 offset 会先下探再折回，画出一个驼峰
    if (flowing) edges.push({ ...common, type: 'flow', data: { offset, borderRadius: 12, color } })
    else edges.push({ ...common, type: 'smoothstep', pathOptions: { borderRadius: 12, offset } })
  })

  flow.push(...lanes, ...groups, ...leaves)
  return { nodes: flow, edges, stageNodes }
}
