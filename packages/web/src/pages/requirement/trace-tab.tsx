import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { Network, Target } from 'lucide-react'
import type { RequirementMetrics, TraceGraph, TraceNodeType } from '@taktflow/core'
import { useAsync } from '../../api'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui'
import { useIsDark } from '../../lib/theme'

const TYPE_META: Record<TraceNodeType, { label: string; color: string; col: number }> = {
  requirement: { label: '需求', color: 'var(--accent)', col: 0 },
  artifact: { label: '产物', color: 'var(--c-7)', col: 1 },
  ac: { label: 'AC', color: 'var(--c-6)', col: 2 },
  case: { label: '用例', color: 'var(--c-2)', col: 3 },
  task: { label: '任务', color: 'var(--c-4)', col: 3 },
  code: { label: '代码', color: 'var(--c-7)', col: 4 },
  evidence: { label: '证据', color: 'var(--c-3)', col: 4 },
  verdict: { label: '判决', color: 'var(--c-5)', col: 5 },
  // 运行节点产出产物，定向时排在产物前面
  'run-node': { label: '节点', color: 'var(--c-1)', col: 0.5 },
}
const REL_COLOR: Record<string, string> = { derives: 'var(--border-strong)', covers: 'var(--c-2)', implements: 'var(--c-4)', verifies: 'var(--c-3)', judged: 'var(--c-5)', produced: 'var(--c-1)' }
const REL_LABEL: Record<string, string> = { derives: '派生', covers: '覆盖', implements: '实现', verifies: '验证', judged: '判决', produced: '产出' }

const STATUS_TONE: Record<string, string> = { passed: 'success', covered: 'success', done: 'success', delivered: 'success', fixed: 'success', failed: 'failed', partial: 'waiting', uncovered: 'pending', active: 'running', changed: 'running' }

type TNode = Node<{ type: TraceNodeType; label: string; full: string; status?: string }, 'trace'>

function TraceNode({ data }: NodeProps<TNode>) {
  const meta = TYPE_META[data.type]
  const tone = data.status ? STATUS_TONE[data.status] : undefined
  return (
    <div className="trace-node" style={{ '--t-color': meta.color } as CSSProperties}>
      <Handle type="target" position={Position.Left} />
      <span className="trace-type">{meta.label}</span>
      <span className="trace-label truncate" title={data.full}>
        {data.label}
      </span>
      {tone && <span className="trace-status" style={{ background: tone === 'pending' ? 'var(--st-pending)' : `var(--st-${tone})` }} title={data.status} />}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
const nodeTypes = { trace: TraceNode }

/**
 * 画布上的短标签：运行节点去掉 runId 前缀；深路径只留最后两段。完整文本在 tooltip 里。
 */
function shortLabel(n: TraceGraph['nodes'][number]): string {
  if (n.type === 'run-node') return n.label.includes(' / ') ? n.label.slice(n.label.indexOf(' / ') + 3) : n.label
  const [path, ...rest] = n.label.split(' · ')
  const parts = path!.split('/')
  if (parts.length <= 2) return n.label
  return [`…/${parts.slice(-2).join('/')}`, ...rest].join(' · ')
}

/**
 * 分层布局：边先按类型顺序定向（需求 → 产物 → AC → 用例 → 证据 → 判决，同类型保持原方向），
 * 再按最长路径分列，没有上游的节点（运行节点、输入物料）贴到它最早的下游左边一列；
 * 列内用前后两遍重心排序减少交叉。真实数据里产物之间的派生链很长，只按类型分列会画出大量同列回环边。
 */
function layout(g: TraceGraph): { nodes: TNode[]; edges: Edge[] } {
  const W = 196
  const H = 34
  const GX = 56
  const GY = 10
  const typeOf = new Map(g.nodes.map((n) => [n.id, n.type]))
  const col = (id: string) => TYPE_META[typeOf.get(id) ?? 'artifact'].col
  const links = g.edges
    .filter((e) => typeOf.has(e.from) && typeOf.has(e.to) && e.from !== e.to)
    .map((e) => (col(e.from) > col(e.to) ? { ...e, from: e.to, to: e.from } : e))
  const ids = g.nodes.map((n) => n.id)
  const succ = new Map(ids.map((id) => [id, [] as string[]]))
  const pred = new Map(ids.map((id) => [id, [] as string[]]))
  for (const e of links) {
    succ.get(e.from)!.push(e.to)
    pred.get(e.to)!.push(e.from)
  }

  // 最长路径分层（Kahn）；成环的剩余节点按类型列兜底
  const rank = new Map<string, number>()
  const indeg = new Map(ids.map((id) => [id, pred.get(id)!.length]))
  const queue = ids.filter((id) => indeg.get(id) === 0)
  for (const id of queue) rank.set(id, 0)
  while (queue.length) {
    const id = queue.shift()!
    for (const t of succ.get(id)!) {
      rank.set(t, Math.max(rank.get(t) ?? 0, rank.get(id)! + 1))
      indeg.set(t, indeg.get(t)! - 1)
      if (indeg.get(t) === 0) queue.push(t)
    }
  }
  for (const id of ids) if (!rank.has(id)) rank.set(id, Math.round(col(id)))
  for (const id of ids) {
    const next = succ.get(id)!
    if (pred.get(id)!.length === 0 && next.length && typeOf.get(id) !== 'requirement') rank.set(id, Math.max(0, Math.min(...next.map((t) => rank.get(t)!)) - 1))
  }

  const columns = new Map<number, string[]>()
  for (const id of ids) columns.set(rank.get(id)!, [...(columns.get(rank.get(id)!) ?? []), id])
  const order = [...columns.keys()].sort((a, b) => a - b).map((r) => columns.get(r)!.sort((a, b) => col(a) - col(b)))
  const pos = new Map<string, number>()
  const index = () => order.forEach((c) => c.forEach((id, i) => pos.set(id, i)))
  index()
  const center = (id: string, side: Map<string, string[]>) => {
    const ns = side.get(id)!.filter((n) => pos.has(n))
    return ns.length ? ns.reduce((s, n) => s + pos.get(n)!, 0) / ns.length : pos.get(id)!
  }
  for (let pass = 0; pass < 4; pass++) {
    const forward = pass % 2 === 0
    const seq = forward ? order : [...order].reverse()
    for (const c of seq) {
      const side = forward ? pred : succ
      const key = new Map(c.map((id) => [id, center(id, side)]))
      c.sort((a, b) => key.get(a)! - key.get(b)!)
      c.forEach((id, i) => pos.set(id, i))
    }
  }

  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const maxH = Math.max(...order.map((c) => c.length * (H + GY)))
  const nodes: TNode[] = []
  order.forEach((c, ci) => {
    const h = c.length * (H + GY)
    c.forEach((id, i) => {
      const n = byId.get(id)!
      nodes.push({ id, type: 'trace', position: { x: ci * (W + GX), y: (maxH - h) / 2 + i * (H + GY) }, data: { type: n.type, label: shortLabel(n), full: n.label, status: n.status }, width: W, height: H, draggable: false })
    })
  })
  const edges: Edge[] = links.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    type: 'default',
    style: { stroke: REL_COLOR[e.rel], strokeWidth: 1.4 },
    label: e.rel === 'derives' || e.rel === 'produced' ? undefined : REL_LABEL[e.rel],
    labelStyle: { fontSize: 10, fill: 'var(--text-3)' },
    labelBgStyle: { fill: 'var(--surface)' },
    labelBgPadding: [4, 2] as [number, number],
  }))
  return { nodes, edges }
}

const TRACE_CANVAS_MAX_H = 560
const MIN_READABLE_ZOOM = 0.8
/** 画布上下留白：上 24，下 56 给横排的缩放控件。 */
const PAD_TOP = 24
const PAD_BOTTOM = 56

/** 整图塞进画布时字太小就不硬塞：保持可读缩放，从左侧（需求、输入物料）开始看，其余拖动或缩放。画布高度随内容收缩，免得大片留白。 */
function initialView(nodes: TNode[], boxWidth: number): { zoom: number; top: number; height: number } {
  const w = Math.max(...nodes.map((n) => n.position.x + (n.width ?? 0)))
  const top = Math.min(...nodes.map((n) => n.position.y))
  const h = Math.max(...nodes.map((n) => n.position.y + (n.height ?? 0))) - top
  const fit = Math.min((boxWidth - 48) / w, (TRACE_CANVAS_MAX_H - PAD_TOP - PAD_BOTTOM) / h)
  const zoom = Math.min(1, Math.max(MIN_READABLE_ZOOM, fit))
  return { zoom, top, height: Math.min(TRACE_CANVAS_MAX_H, Math.max(240, h * zoom + PAD_TOP + PAD_BOTTOM)) }
}

/** 悬停某个节点时只突出它的直接上下游，真实数据的派生边很多，不这样基本看不清。 */
function highlight(flow: { nodes: TNode[]; edges: Edge[] } | null, focus?: string): { nodes: TNode[]; edges: Edge[] } | null {
  if (!flow || !focus) return flow
  const near = new Set([focus])
  for (const e of flow.edges) if (e.source === focus || e.target === focus) near.add(e.source).add(e.target)
  return {
    nodes: flow.nodes.map((n) => (near.has(n.id) ? n : { ...n, className: 'dim' })),
    edges: flow.edges.map((e) => (e.source === focus || e.target === focus ? { ...e, zIndex: 2, style: { ...e.style, strokeWidth: 2 } } : { ...e, style: { ...e.style, opacity: 0.12 }, label: undefined })),
  }
}

function AcCards({ m }: { m: RequirementMetrics }) {
  const list = m.acCoverage ?? []
  if (list.length === 0) return null
  const STATUS = { covered: { label: '已覆盖', tone: 'success' }, partial: { label: '部分通过', tone: 'waiting' }, uncovered: { label: '未覆盖', tone: 'pending' } } as const
  return (
    <div className="ac-grid">
      {list.map((a) => {
        const s = STATUS[a.status]
        const reason = a.status === 'uncovered' ? (a.cases === 0 ? '没有用例映射到这条 AC' : '用例尚未执行') : a.failed > 0 ? `${a.failed} 条用例未通过` : a.passed < a.cases ? `${a.cases - a.passed} 条用例未执行` : '全部用例通过'
        return (
          <div key={a.ac} className={`card ac-card ac-${a.status}`}>
            <div className="ac-head">
              <span className="mono ac-id">{a.ac}</span>
              <span className="ac-status" style={{ color: s.tone === 'pending' ? 'var(--text-3)' : `var(--st-${s.tone})`, background: s.tone === 'pending' ? 'var(--surface-hover)' : `var(--st-${s.tone}-soft)` }}>
                {s.label}
              </span>
            </div>
            <div className="ac-title">{a.title}</div>
            <div className="ac-bar">
              <span style={{ flex: a.passed, background: 'var(--st-success)' }} />
              <span style={{ flex: a.failed, background: 'var(--st-failed)' }} />
              <span style={{ flex: Math.max(0, a.cases - a.passed - a.failed) || (a.cases === 0 ? 1 : 0), background: 'var(--bg-sunken)' }} />
            </div>
            <div className="ac-nums">
              <span>
                用例 <b className="num">{a.cases}</b>
              </span>
              <span>
                通过 <b className="num" style={{ color: 'var(--st-success)' }}>{a.passed}</b>
              </span>
              <span>
                未通过 <b className="num" style={{ color: a.failed ? 'var(--st-failed)' : undefined }}>{a.failed}</b>
              </span>
            </div>
            <div className="ac-reason">{reason}</div>
          </div>
        )
      })}
    </div>
  )
}

export function TraceTab({ id }: { id: string }) {
  const dark = useIsDark()
  const q = useAsync(async (ds) => {
    const [trace, metrics] = await Promise.all([ds.trace(id), ds.metrics(id)])
    return { trace, metrics }
  }, [id])
  const flow = useMemo(() => (q.data ? layout(q.data.trace) : null), [q.data])
  const [hover, setHover] = useState<string>()
  const [canvasH, setCanvasH] = useState<number>()
  const canvasRef = useRef<HTMLDivElement>(null)
  const view = useMemo(() => highlight(flow, hover), [flow, hover])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data || !flow || !view)
    return (
      <div className="ac-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card ac-card">
            <Skeleton w={60} h={12} />
            <Skeleton w="80%" h={12} style={{ marginTop: 12 }} />
            <Skeleton h={6} style={{ marginTop: 16 }} />
          </div>
        ))}
      </div>
    )
  const cov = q.data.metrics.acCoverage ?? []
  const covered = cov.filter((a) => a.status === 'covered').length
  return (
    <div className="trace-tab">
      <div className="section-head">
        <Target />
        <span className="card-title">验收标准覆盖</span>
        {cov.length > 0 && (
          <span className="faint">
            {covered}/{cov.length} 条 AC 已覆盖并通过 · 准出以用例结论为准，不以节点 succeeded 为准
          </span>
        )}
      </div>
      {cov.length ? <AcCards m={q.data.metrics} /> : <div className="card"><EmptyState compact icon={Target} title="还没有验收标准" hint="spec 里的 AC-<n> 会自动出现在这里。" /></div>}

      <div className="section-head" style={{ marginTop: 24 }}>
        <Network />
        <span className="card-title">追溯图</span>
        <span className="faint">需求 → AC → 用例 / 任务 → 证据 / 代码 → 判决</span>
        <span style={{ flex: 1 }} />
        <span className="trace-legend">
          {(['derives', 'produced', 'covers', 'implements', 'verifies', 'judged'] as const).map((r) => (
            <span key={r}>
              <i style={{ background: REL_COLOR[r] }} />
              {REL_LABEL[r]}
            </span>
          ))}
        </span>
      </div>
      <div className="card trace-canvas" ref={canvasRef} style={canvasH ? { height: canvasH } : undefined}>
        {flow.nodes.length === 0 ? (
          <EmptyState icon={Network} title="追溯图为空" hint="产物里出现的 REQ- / AC- / TC- 编号会自动连成追溯图。" />
        ) : (
          <ReactFlow
            nodes={view.nodes}
            edges={view.edges}
            nodeTypes={nodeTypes}
            onInit={(rf) => {
              const v = initialView(view.nodes, canvasRef.current?.clientWidth ?? 1000)
              setCanvasH(v.height)
              void rf.setViewport({ x: 24, y: PAD_TOP - v.top * v.zoom, zoom: v.zoom })
            }}
            colorMode={dark ? 'dark' : 'light'}
            nodesConnectable={false}
            nodesDraggable={false}
            onNodeMouseEnter={(_, n) => setHover(n.id)}
            onNodeMouseLeave={() => setHover(undefined)}
            proOptions={{ hideAttribution: true }}
            minZoom={0.3}
            panOnScroll
          >
            <Background gap={18} size={1} color="var(--grid-dot)" />
            <Controls showInteractive={false} position="bottom-left" orientation="horizontal" />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
