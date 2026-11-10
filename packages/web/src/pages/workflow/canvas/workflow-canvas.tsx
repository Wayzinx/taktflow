import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, Controls, Panel, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type EdgeChange, type NodeChange, type Viewport } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Lock } from 'lucide-react'
import type { WorkflowEdit } from '@taktflow/core'
import { findNode, lit, literalOf, needsOf } from '../../../api/workflow-edit'
import { toast } from '../../../components/ui'
import { currentSpaceId } from '../../../lib/space'
import { useIsDark } from '../../../lib/theme'
import { addNode, type Placement } from '../palette/add-node'
import { DRAG_MIME, paletteItem } from '../palette/node-defaults'
import { ReviewWizard } from '../palette/review-wizard'
import type { WorkflowDocState } from '../state'
import { buildFlow, type EditorEdge, type EditorNode } from './build-flow'
import { edgeTypes } from './canvas-edges'
import { nodeTypes } from './canvas-nodes'
import { canConnect, laneIndexAt, NH, NW, type Pos } from './graph'
import { GhostOverlay } from './ghost-overlay'
import type { WorkflowPreview } from '../../../lib/ui-store'
import './canvas.css'

export interface WorkflowCanvasProps {
  wf: WorkflowDocState
  selected?: string
  onSelect: (nodeId: string | undefined) => void
  /** 需要高亮的节点（远端变更、诊断）。 */
  highlight?: string[]
  /** 管家 workflow 提案的幽灵预览（A 组 ghost-overlay.tsx；骨架预留）。 */
  ghost?: WorkflowPreview
}

/** 画布视口是个人的浏览位置：只记在本机，不写进共享的 layout（否则一个人拖动画布，所有人下次打开都停在那里）。 */
const viewportKey = (id: string) => `takt:wf-viewport:${currentSpaceId() ?? ''}:${id}`
function readViewport(id?: string): Viewport | undefined {
  if (!id) return undefined
  try {
    const v = JSON.parse(localStorage.getItem(viewportKey(id)) ?? 'null') as Viewport | null
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom) ? v : undefined
  } catch {
    return undefined
  }
}
function writeViewport(id: string | undefined, v: Viewport) {
  if (!id) return
  try {
    localStorage.setItem(viewportKey(id), JSON.stringify(v))
  } catch {
    // 存储不可用：下次从第一个泳道打开
  }
}

/** React Flow 画布：阶段泳道、节点卡片、连线即依赖（setNeeds）、拖动（wf.saveLayout）、loop / planner 分组。只读时禁用交互。 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

function Canvas({ wf, selected, onSelect, highlight, ghost }: WorkflowCanvasProps) {
  const dark = useIsDark()
  const rf = useReactFlow<EditorNode, EditorEdge>()
  const [dropLane, setDropLane] = useState<number>()
  const [wizard, setWizard] = useState<Placement>()
  // 冲突未解决时写入会被丢弃，画布同样锁住
  const locked = wf.readOnly || wf.status === 'conflict'
  const hl = (highlight ?? []).join(',')
  const flow = useMemo(
    () => (wf.model ? buildFlow({ model: wf.model, layout: wf.layout, diagnostics: wf.doc?.diagnostics, selected, highlight: hl ? hl.split(',') : [], readOnly: locked, dropLane }) : undefined),
    [wf.model, wf.layout, wf.doc?.diagnostics, selected, hl, locked, dropLane],
  )
  const [nodes, setNodes] = useState<EditorNode[]>([])
  const [edges, setEdges] = useState<EditorEdge[]>([])
  useEffect(() => {
    setNodes(flow?.nodes ?? [])
    setEdges(flow?.edges ?? [])
  }, [flow])

  const model = wf.model
  const apply = useCallback(
    (edits: WorkflowEdit[], reason: string) => {
      if (edits.length) void wf.applyEdits(edits, { reason })
    },
    [wf],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!model || locked) return
      const err = canConnect(model, c.source, c.target)
      if (err) return toast('不能添加依赖', { body: err, tone: 'failed' })
      const t = findNode(model.nodes, c.target)!.node
      apply([{ op: 'setNeeds', id: c.target, needs: [...needsOf(t), c.source] }], `${c.target} 依赖 ${c.source}`)
    },
    [model, locked, apply],
  )

  const onEdgesDelete = useCallback(
    (removed: EditorEdge[]) => {
      if (!model) return
      const drop = new Map<string, Set<string>>()
      for (const e of removed) if (e.data?.kind === 'need') drop.set(e.target, (drop.get(e.target) ?? new Set()).add(e.source))
      const edits: WorkflowEdit[] = []
      for (const [target, sources] of drop) {
        const n = findNode(model.nodes, target)
        if (n) edits.push({ op: 'setNeeds', id: target, needs: needsOf(n.node).filter((s) => !sources.has(s)) })
      }
      apply(edits, '删除依赖')
    },
    [model, apply],
  )

  const onNodesDelete = useCallback(
    (removed: EditorNode[]) => {
      const real = removed.filter((n) => n.type !== 'lane')
      const ids = new Set(real.map((n) => n.id))
      // 删除 loop 时 React Flow 会连带传入循环体节点，removeNode(loop) 已经包含它们
      const edits: WorkflowEdit[] = real.filter((n) => !n.parentId || !ids.has(n.parentId)).map((n) => ({ op: 'removeNode', id: n.id }))
      if (selected && ids.has(selected)) onSelect(undefined)
      apply(edits, `删除节点 ${[...ids].join('、')}`)
    },
    [apply, onSelect, selected],
  )

  const onNodeDragStop = useCallback(
    (_: unknown, __: EditorNode, dragged: EditorNode[]) => {
      if (!flow || !model || locked) return
      const moved = new Set(dragged.map((n) => n.id))
      const next: Record<string, Pos> = { ...flow.abs }
      const edits: WorkflowEdit[] = []
      const notes: string[] = []
      for (const n of dragged) {
        if (n.type === 'lane' || (n.parentId && moved.has(n.parentId))) continue
        const origin = n.parentId ? flow.abs[n.parentId]! : { x: 0, y: 0 }
        const abs = { x: Math.round(origin.x + n.position.x), y: Math.round(origin.y + n.position.y) }
        if (n.type === 'loop') {
          const old = flow.abs[n.id]!
          for (const k of findNode(model.nodes, n.id)?.node.body ?? []) next[k.id] = { x: next[k.id]!.x + abs.x - old.x, y: next[k.id]!.y + abs.y - old.y }
        }
        next[n.id] = abs
        if (n.parentId) continue
        // 顶层节点跨泳道 = 改阶段；stage 是代码值时只挪位置
        const node = findNode(model.nodes, n.id)!.node
        const width = n.type === 'loop' ? n.data.w : NW
        const stage = flow.stages[laneIndexAt(abs.x + width / 2, flow.stages.length)]
        const cur = node.props.stage
        if (stage && cur?.kind !== 'code' && literalOf<string>(cur) !== stage.id) {
          edits.push({ op: 'setProp', id: n.id, key: 'stage', value: lit(stage.id) })
          notes.push(`${n.id} 移到阶段 ${stage.title}`)
        }
      }
      wf.saveLayout({ ...(wf.layout ?? { nodes: {} }), nodes: next })
      apply(edits, notes.join('；'))
    },
    [flow, model, locked, wf, apply],
  )

  const placementAt = (e: DragEvent): Placement & { position: Pos } => {
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const loop = nodes.find((n) => n.type === 'loop' && p.x >= n.position.x && p.x <= n.position.x + n.data.w && p.y >= n.position.y && p.y <= n.position.y + n.data.h)
    const stage = flow?.stages[laneIndexAt(p.x, flow.stages.length)]?.id
    return { stage, parent: loop?.id, position: { x: Math.round(p.x - NW / 2), y: Math.round(p.y - NH / 2) } }
  }

  function onDragOver(e: DragEvent) {
    if (locked || !e.dataTransfer.types.includes(DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const lane = flow?.stages.length ? laneIndexAt(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }).x, flow.stages.length) : undefined
    if (lane !== dropLane) setDropLane(lane)
  }

  function onDrop(e: DragEvent) {
    setDropLane(undefined)
    const item = paletteItem(e.dataTransfer.getData(DRAG_MIME))
    if (locked || !item) return
    e.preventDefault()
    const at = placementAt(e)
    if (item.topOnly) at.parent = undefined
    if (item.kind === 'review') return setWizard(at)
    void addNode(wf, item.kind, item.defaults(), at).then((id) => id && onSelect(id))
  }

  return (
    <div className={`wf-canvas${locked ? ' is-locked' : ''}`} onDragOver={onDragOver} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropLane(undefined)} onDrop={onDrop}>
      <ReactFlow<EditorNode, EditorEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={dark ? 'dark' : 'light'}
        onNodesChange={(c: NodeChange<EditorNode>[]) => setNodes((ns) => applyNodeChanges(c, ns))}
        onEdgesChange={(c: EdgeChange<EditorEdge>[]) => setEdges((es) => applyEdgeChanges(c, es))}
        onConnect={onConnect}
        isValidConnection={(c) => !!model && !canConnect(model, c.source, c.target)}
        onConnectEnd={(e, state) => {
          // 松手在节点卡片上（而不是正好在连接点上）也算连线：按指针下的节点补一条依赖
          if (state.isValid || state.fromHandle?.type !== 'source' || !state.fromNode) return
          const p = 'changedTouches' in e ? e.changedTouches[0]! : e
          const el = document.elementFromPoint(p.clientX, p.clientY)?.closest<HTMLElement>('.react-flow__node-wf, .react-flow__node-loop')
          const target = el?.dataset.id
          if (target && target !== state.fromNode.id) onConnect({ source: state.fromNode.id, target, sourceHandle: null, targetHandle: null })
        }}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, n) => n.type !== 'lane' && onSelect(n.id)}
        onPaneClick={() => onSelect(undefined)}
        onMoveEnd={(_, viewport) => writeViewport(wf.doc?.id, viewport)}
        // 本机没看过时从第一个泳道开始、按可读的缩放打开；fitView 会把 20+ 节点的流水线缩到看不清
        defaultViewport={readViewport(wf.doc?.id) ?? { x: 16, y: 12, zoom: 0.8 }}
        nodesDraggable={!locked}
        nodesConnectable={!locked}
        elementsSelectable
        deleteKeyCode={locked ? null : ['Delete', 'Backspace']}
        connectionRadius={28}
        minZoom={0.25}
        maxZoom={1.6}
        panOnScroll
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--grid-dot)" />
        <Controls showInteractive={false} position="bottom-left" />
        <Panel position="bottom-right" className="wf-legend">
          <span><i className="lg-dep" />依赖</span>
          <span><i className="lg-route" />判决路由</span>
          <span><i className="lg-rework" />打回</span>
          {locked ? (
            <span className="wf-locked"><Lock />{wf.readOnly ? '只读' : '冲突待解决'}</span>
          ) : (
            <span className="wf-canvas-hint">拖连接点到另一节点 = 添加依赖 · 选中后 Delete 删除</span>
          )}
        </Panel>
        {ghost && <GhostOverlay preview={ghost} />}
      </ReactFlow>
      {wizard && <ReviewWizard wf={wf} placement={wizard} onClose={() => setWizard(undefined)} onDone={onSelect} />}
    </div>
  )
}
