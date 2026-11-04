import { useMemo, type CSSProperties } from 'react'
import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
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
  'run-node': { label: '节点', color: 'var(--c-1)', col: 5 },
}
const REL_COLOR: Record<string, string> = { derives: 'var(--border-strong)', covers: 'var(--c-2)', implements: 'var(--c-4)', verifies: 'var(--c-3)', judged: 'var(--c-5)', produced: 'var(--c-1)' }
const REL_LABEL: Record<string, string> = { derives: '派生', covers: '覆盖', implements: '实现', verifies: '验证', judged: '判决', produced: '产出' }

const STATUS_TONE: Record<string, string> = { passed: 'success', covered: 'success', done: 'success', delivered: 'success', fixed: 'success', failed: 'failed', partial: 'waiting', uncovered: 'pending', active: 'running', changed: 'running' }

type TNode = Node<{ type: TraceNodeType; label: string; status?: string }, 'trace'>

function TraceNode({ data }: NodeProps<TNode>) {
  const meta = TYPE_META[data.type]
  const tone = data.status ? STATUS_TONE[data.status] : undefined
  return (
    <div className="trace-node" style={{ '--t-color': meta.color } as CSSProperties}>
      <Handle type="target" position={Position.Left} />
      <span className="trace-type">{meta.label}</span>
      <span className="trace-label truncate" title={data.label}>
        {data.label}
      </span>
      {tone && <span className="trace-status" style={{ background: tone === 'pending' ? 'var(--st-pending)' : `var(--st-${tone})` }} title={data.status} />}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
const nodeTypes = { trace: TraceNode }

function layout(g: TraceGraph): { nodes: TNode[]; edges: Edge[] } {
  const W = 216
  const H = 34
  const GX = 72
  const GY = 12
  const cols = new Map<number, TraceGraph['nodes']>()
  for (const n of g.nodes) {
    const c = TYPE_META[n.type].col
    cols.set(c, [...(cols.get(c) ?? []), n])
  }
  const used = [...cols.keys()].sort((a, b) => a - b)
  const maxH = Math.max(...[...cols.values()].map((c) => c.length * (H + GY)))
  const nodes: TNode[] = []
  used.forEach((c, ci) => {
    const list = cols.get(c)!
    const h = list.length * (H + GY)
    list.forEach((n, i) => {
      nodes.push({ id: n.id, type: 'trace', position: { x: ci * (W + GX), y: (maxH - h) / 2 + i * (H + GY) }, data: { type: n.type, label: n.label, status: n.status }, width: W, height: H, draggable: false })
    })
  })
  const col = (id: string) => TYPE_META[g.nodes.find((n) => n.id === id)?.type ?? 'artifact'].col
  const edges: Edge[] = g.edges.map((e, i) => {
    const flip = col(e.from) > col(e.to)
    return {
      id: `e${i}`,
      source: flip ? e.to : e.from,
      target: flip ? e.from : e.to,
      type: 'default',
      style: { stroke: REL_COLOR[e.rel], strokeWidth: 1.4 },
      label: e.rel === 'derives' ? undefined : REL_LABEL[e.rel],
      labelStyle: { fontSize: 10, fill: 'var(--text-3)' },
      labelBgStyle: { fill: 'var(--surface)' },
      labelBgPadding: [4, 2] as [number, number],
    }
  })
  return { nodes, edges }
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
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data || !flow)
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
          {(['covers', 'implements', 'verifies', 'judged'] as const).map((r) => (
            <span key={r}>
              <i style={{ background: REL_COLOR[r] }} />
              {REL_LABEL[r]}
            </span>
          ))}
        </span>
      </div>
      <div className="card trace-canvas">
        {flow.nodes.length === 0 ? (
          <EmptyState icon={Network} title="追溯图为空" hint="产物里出现的 REQ- / AC- / TC- 编号会自动连成追溯图。" />
        ) : (
          <ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.12, maxZoom: 1 }} colorMode={dark ? 'dark' : 'light'} nodesConnectable={false} nodesDraggable={false} proOptions={{ hideAttribution: true }} minZoom={0.3}>
            <Background gap={18} size={1} color="var(--grid-dot)" />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
