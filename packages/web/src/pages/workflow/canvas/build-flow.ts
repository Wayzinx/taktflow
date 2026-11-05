import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { EditableNode, EditableWorkflow, VerdictCategory, WorkflowDiagnostic, WorkflowLayout } from '@taktflow/core'
import { allNodes, findNode, literalOf, needsOf } from '../../../api/workflow-edit'
import { VERDICT } from '../../../lib/status'
import { contentBottom, diagnosticsByNode, LANE_INNER, laneX, loopBox, NW, nodeHeight, resolvePositions, stagesOf, type Pos, type Stage } from './graph'

export interface WfNodeData extends Record<string, unknown> {
  node: EditableNode
  selected: boolean
  changed: boolean
  diags: WorkflowDiagnostic[]
}
export interface LoopData extends WfNodeData {
  w: number
  h: number
}
export interface LaneData extends Record<string, unknown> {
  stage: Stage
  index: number
  count: number
  h: number
  drop: boolean
}
export type EditorNode = Node<WfNodeData, 'wf'> | Node<LoopData, 'loop'> | Node<LaneData, 'lane'>

export type EdgeKind = 'need' | 'route' | 'rework'
export interface WfEdgeData extends Record<string, unknown> {
  kind: EdgeKind
  readOnly: boolean
}
export type EditorEdge = Edge<WfEdgeData, 'wf'>

export const LANE_PREFIX = '__lane__/'
export const needEdgeId = (source: string, target: string) => `need:${source}->${target}`

export interface FlowInput {
  model: EditableWorkflow
  layout?: WorkflowLayout
  diagnostics?: WorkflowDiagnostic[]
  selected?: string
  highlight?: string[]
  readOnly: boolean
  dropLane?: number
}

export interface Flow {
  nodes: EditorNode[]
  edges: EditorEdge[]
  /** 每个节点的绝对坐标（含 loop 分组框左上角），拖动结束后据此写布局。 */
  abs: Record<string, Pos>
  stages: Stage[]
}

export function buildFlow({ model, layout, diagnostics, selected, highlight, readOnly, dropLane }: FlowInput): Flow {
  const stages = stagesOf(model)
  const pos = resolvePositions(model, layout)
  const abs: Record<string, Pos> = { ...pos }
  const diags = diagnosticsByNode(diagnostics)
  const changed = new Set(highlight ?? [])
  const nodes: EditorNode[] = []
  const laneH = Math.max(contentBottom(model, pos) + 40, 520)
  stages.forEach((stage, index) =>
    nodes.push({
      id: LANE_PREFIX + stage.id,
      type: 'lane',
      position: { x: laneX(index), y: 0 },
      data: { stage, index, count: model.nodes.filter((n) => literalOf<string>(n.props.stage) === stage.id).length, h: laneH, drop: dropLane === index },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      focusable: false,
      zIndex: -1,
      style: { width: LANE_INNER, height: laneH },
    }),
  )

  const base = (n: EditableNode): WfNodeData => ({ node: n, selected: n.id === selected, changed: changed.has(n.id), diags: diags.get(n.id) ?? [] })
  for (const n of model.nodes) {
    if (n.kind !== 'loop') {
      nodes.push({ id: n.id, type: 'wf', position: pos[n.id]!, data: base(n), selected: n.id === selected, deletable: !readOnly, style: { width: NW, height: nodeHeight(n.kind) } })
      continue
    }
    const box = loopBox(n, pos)
    abs[n.id] = { x: box.x, y: box.y }
    nodes.push({ id: n.id, type: 'loop', position: { x: box.x, y: box.y }, data: { ...base(n), w: box.w, h: box.h }, selected: n.id === selected, deletable: !readOnly, style: { width: box.w, height: box.h } })
    for (const k of n.body ?? []) {
      const p = pos[k.id]!
      nodes.push({ id: k.id, type: 'wf', parentId: n.id, position: { x: p.x - box.x, y: p.y - box.y }, data: base(k), selected: k.id === selected, deletable: !readOnly, style: { width: NW, height: nodeHeight(k.kind) } })
    }
  }
  return { nodes, edges: buildEdges(model, abs, readOnly, selected), abs, stages }
}

function handles(a: Pos, b: Pos): { sourceHandle: string; targetHandle: string } {
  // 同列（上下相邻）走下 → 上，其余走右 → 左
  if (Math.abs(a.x - b.x) < NW * 0.6 && b.y > a.y) return { sourceHandle: 'b', targetHandle: 't' }
  return { sourceHandle: 'r', targetHandle: 'l' }
}

function buildEdges(model: EditableWorkflow, abs: Record<string, Pos>, readOnly: boolean, selected?: string): EditorEdge[] {
  const edges: EditorEdge[] = []
  const at = (id: string) => abs[id] ?? { x: 0, y: 0 }
  const marker = (color: string) => ({ type: MarkerType.ArrowClosed, width: 16, height: 16, color })
  for (const n of allNodes(model.nodes)) {
    for (const src of needsOf(n)) {
      if (!findNode(model.nodes, src)) continue
      const hot = selected === n.id || selected === src
      edges.push({
        id: needEdgeId(src, n.id),
        type: 'wf',
        source: src,
        target: n.id,
        ...handles(at(src), at(n.id)),
        data: { kind: 'need', readOnly },
        deletable: !readOnly,
        markerEnd: marker(hot ? 'var(--accent)' : 'var(--text-3)'),
        className: hot ? 'is-hot' : undefined,
      })
    }
    if (n.kind === 'judge') {
      const routes = literalOf<Partial<Record<VerdictCategory, string>>>(n.props.routes) ?? {}
      for (const [cat, target] of Object.entries(routes)) {
        if (!target || target === 'human' || target === 'ignore' || !findNode(model.nodes, target)) continue
        // 路由目标同时依赖判决节点：依赖边已经画出，这里只补一个类别标签
        const dup = edges.find((e) => e.source === n.id && e.target === target && e.data?.kind === 'need')
        if (dup) {
          dup.label = [dup.label, VERDICT[cat as VerdictCategory]?.label ?? cat].filter(Boolean).join(' / ')
          continue
        }
        edges.push({ id: `route:${n.id}:${cat}`, type: 'wf', source: n.id, target, ...handles(at(n.id), at(target)), data: { kind: 'route', readOnly: true }, deletable: false, selectable: false, label: VERDICT[cat as VerdictCategory]?.label ?? cat, markerEnd: marker('var(--c-6)') })
      }
    }
    if (n.kind === 'review') {
      const policy = literalOf<{ rework?: string }>(n.props.onExhausted)
      const target = typeof policy === 'object' ? policy?.rework : undefined
      if (target && findNode(model.nodes, target)) {
        edges.push({ id: `rework:${n.id}`, type: 'wf', source: n.id, target, sourceHandle: 'ls', targetHandle: 'l', data: { kind: 'rework', readOnly: true }, deletable: false, selectable: false, label: '打回', markerEnd: marker('var(--st-stale)') })
      }
    }
  }
  return edges
}
