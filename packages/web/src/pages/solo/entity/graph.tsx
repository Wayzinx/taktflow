import { useEffect, useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, Controls, ReactFlow, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ScrollText, SquareArrowOutUpRight } from 'lucide-react'
import type { RunDetail, StewardEntitySnapshot } from '@taktflow/core'
import { useAsync } from '../../../api'
import { ActivityLine } from '../../../components/activity-line'
import { AttentionCard } from '../../../components/attention-card'
import { describe } from '../../../components/event-timeline'
import { useEntityFocus, type FocusTarget } from '../../../components/steward/focus'
import { KindIcon, Skeleton, StatusBadge } from '../../../components/ui'
import { fmtDuration, fmtTime } from '../../../lib/format'
import { Link, navigate, useSpaceHref } from '../../../lib/router'
import { NODE_STATUS, RUN_STATUS } from '../../../lib/status'
import { useIsDark } from '../../../lib/theme'
import { decorate, useCompletionPulses, useReplay } from '../../run/canvas-motion'
import { layoutRun, type FlowNode } from '../../run/dag-layout'
import { edgeTypes } from '../../run/dag-edges'
import { nodeTypes } from '../../run/dag-nodes'
import { nodeLabel } from '../../run/node-label'
import '../../run/run.css'
import '../../run/run-motion.css'
import { CardSkeleton } from './card'
import { EntityFoot, SnapshotCard, useInView, useKept, useRunEvents, useTick } from './shared'

const isLive = (s?: string) => s === 'running' || s === 'waiting_human'

/** 运行详情，跟着运行事件刷新。 */
export function useRunLive(runId: string) {
  const [tick, bump] = useTick()
  const q = useAsync((ds) => ds.run(runId), [runId, tick])
  const d = useKept(q.data)
  useRunEvents(runId, isLive(d?.run.status), bump)
  return { d, tick, error: q.error }
}

/**
 * 只读运行图（运行页画布的同一套布局、节点与边）：聚焦选中节点所在阶段，否则聚焦在跑的阶段。
 * 会话里（interactive 为 false）不抢滚轮，滚动照常翻会话；焦点面板里可以缩放平移。
 */
export function RunGraph({ detail, selected, onSelect, interactive }: { detail: RunDetail; selected?: string; onSelect?: (nodeId: string) => void; interactive?: boolean }) {
  const dark = useIsDark()
  const stages = useMemo(() => detail.stages ?? [], [detail])
  const layout = useMemo(() => layoutRun(detail.graph, detail.workflow.stages, stages, detail.run.expansions, selected), [detail, stages, selected])
  const [hover, setHover] = useState<string>()
  const pulses = useCompletionPulses(detail.graph.nodes)
  const replay = useReplay(detail)
  const view = useMemo(() => decorate(layout, hover ?? selected, pulses, replay), [layout, hover, selected, pulses, replay])
  const rf = useRef<ReactFlowInstance<FlowNode> | null>(null)

  const sel = selected ? detail.graph.nodes.find((n) => n.id === selected) : undefined
  const active = stages.find((s) => s.status === 'running' || s.status === 'waiting_human' || s.status === 'failed')
  const stageId = sel?.stage ?? active?.id ?? stages[stages.length - 1]?.id
  const fit = (i: ReactFlowInstance<FlowNode>, animate: boolean) => {
    const ids = stageId ? (layout.stageNodes.get(stageId) ?? []) : []
    void i.fitView({ nodes: ids.length ? [...ids, `__lane__/${stageId}`].map((id) => ({ id })) : undefined, padding: 0.12, maxZoom: 0.95, minZoom: 0.3, duration: animate ? 400 : 0 })
  }
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    if (rf.current) fitRef.current(rf.current, true)
  }, [stageId])

  return (
    <div className="run-canvas ent-canvas" data-interactive={interactive || undefined}>
      <ReactFlow<FlowNode>
        nodes={view.nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={dark ? 'dark' : 'light'}
        onInit={(i) => {
          rf.current = i
          fit(i, false)
        }}
        onNodeClick={(_, n) => {
          if (n.type === 'lane') return
          onSelect?.(n.id.startsWith('__expand__/') ? n.id.slice('__expand__/'.length) : n.id)
        }}
        onNodeMouseEnter={(_, n) => n.type === 'dag' && setHover(n.id)}
        onNodeMouseLeave={() => setHover(undefined)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={interactive}
        panOnScroll={interactive}
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        preventScrolling={interactive}
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--grid-dot)" />
        {interactive && <Controls showInteractive={false} position="bottom-left" />}
      </ReactFlow>
    </div>
  )
}

function RunHead({ d, spaceId }: { d: RunDetail; spaceId?: string }) {
  const done = d.graph.nodes.filter((n) => n.status === 'succeeded' || n.status === 'skipped').length
  return (
    <div className="ent-head">
      {spaceId && <span className="ent-space">{spaceId}</span>}
      <span className="ent-id mono">{d.run.requirementId}</span>
      <b className="ent-title truncate">{d.workflow.title}</b>
      <span className="ent-gap" />
      <span className="faint num">
        {done}/{d.graph.nodes.length}
      </span>
      <StatusBadge meta={RUN_STATUS[d.run.status]} subtle />
    </div>
  )
}

/** dag：会话里的只读运行图；点节点在焦点面板里打开它（停靠面板里跳运行页）。滚出视口就卸下画布，同时活着的图不多。 */
export function DagView({ runId, node, target, snapshot, inPanel }: { runId: string; node?: string; target: FocusTarget; snapshot?: StewardEntitySnapshot; inPanel?: boolean }) {
  const [box, visible] = useInView<HTMLDivElement>()
  const { d, error } = useRunLive(runId)
  const focus = useEntityFocus()
  const at = useSpaceHref()
  if (error && !d) return snapshot ? <SnapshotCard snapshot={snapshot} reason="拿不到实时数据" /> : null
  if (!d) return <CardSkeleton rows={3} />
  const open = (n: string) => (focus ? focus.open({ ref: target.ref, node: n }) : navigate(at(`/run/${runId}?node=${encodeURIComponent(n)}`)))
  return (
    <div className="ent ent-dag">
      <RunHead d={d} spaceId={target.ref.spaceId} />
      <div ref={box} className="ent-canvas-box">
        {visible ? <RunGraph detail={d} selected={node} onSelect={open} /> : <Skeleton h="100%" r={10} />}
      </div>
      <EntityFoot target={target} live={isLive(d.run.status)} at={d.run.endedAt ?? d.run.startedAt} inPanel={inPanel} />
    </div>
  )
}

/** node：状态、harness / 模型、正在做什么、上下文、最近事件、等你的事，按钮直达执行详情。 */
export function NodeView({ runId, nodeId, target, run, inPanel }: { runId: string; nodeId: string; target: FocusTarget; run?: RunDetail; inPanel?: boolean }) {
  const own = useRunLive(runId)
  const d = run ?? own.d
  const g = d?.graph.nodes.find((n) => n.id === nodeId)
  const tickKey = g ? `${g.status}:${g.attempts}:${g.activity?.since ?? ''}` : ''
  const q = useAsync((ds) => ds.node(runId, nodeId), [runId, nodeId, tickKey])
  const n = useKept(q.data)
  const att = useAsync((ds) => (g?.status === 'waiting_human' ? ds.attention(true) : Promise.resolve([])), [runId, nodeId, g?.status])
  const pending = (att.data ?? []).filter((a) => a.runId === runId && a.nodeId === nodeId && !a.answeredAt)
  if (q.error && !n && !g) return <p className="ent-note">拿不到这个节点：{q.error.message}</p>
  if (!g && !n) return <CardSkeleton rows={3} />
  const status = n?.state.status ?? g!.status
  const kind = n?.kind ?? g!.kind
  const title = g && d ? nodeLabel(g, d.run.expansions).title : (n?.title ?? nodeId)
  const snap = n?.context.snapshots.at(-1)
  const ctx = snap && snap.budgetTokens ? snap.totalTokens / snap.budgetTokens : undefined
  const started = n?.state.startedAt
  const ms = started ? (n?.state.endedAt ? Date.parse(n.state.endedAt) : Date.now()) - Date.parse(started) : undefined
  const harness = n?.recipe?.harness ?? g?.harness
  // 流式消息会落成几条同样的文字，相邻相同的只留一条
  const events = (n?.events ?? [])
    .map((e) => ({ e, title: describe(e).title }))
    .filter((x, i, all) => x.title !== all[i + 1]?.title)
    .slice(-5)
    .reverse()
  const page = `/run/${runId}?node=${encodeURIComponent(nodeId)}`
  return (
    <div className="ent ent-node">
      <div className="ent-head">
        <KindIcon kind={kind} size={24} />
        <b className="ent-title truncate">{title}</b>
        <span className="ent-gap" />
        <StatusBadge meta={NODE_STATUS[status]} subtle />
      </div>
      <dl className="ent-rows">
        {(n?.role ?? g?.role) && (
          <>
            <dt>角色</dt>
            <dd className="mono">{n?.role ?? g?.role}</dd>
          </>
        )}
        {harness && (
          <>
            <dt>Harness</dt>
            <dd className="mono">
              {harness}
              {n?.recipe?.model ? ` · ${n.recipe.model}` : ''}
              {n?.recipe?.effort ? ` · ${n.recipe.effort}` : ''}
            </dd>
          </>
        )}
        {g?.activity && status === 'running' && (
          <>
            <dt>正在做</dt>
            <dd>
              <ActivityLine activity={g.activity} />
            </dd>
          </>
        )}
        {ctx !== undefined && (
          <>
            <dt>上下文</dt>
            <dd>
              <span className="num">{Math.round(ctx * 100)}%</span>
              <span className="ent-ctx" data-hot={ctx >= 0.8 || undefined}>
                <i style={{ transform: `scaleX(${Math.min(1, ctx)})` }} />
              </span>
            </dd>
          </>
        )}
        {ms !== undefined && (
          <>
            <dt>用时</dt>
            <dd className="num">
              {fmtDuration(ms)}
              {(n?.state.attempts ?? 0) > 1 ? ` · 第 ${n!.state.attempts} 次` : ''}
            </dd>
          </>
        )}
        {(n?.summary ?? n?.state.summary ?? g?.summary) && (
          <>
            <dt>小结</dt>
            <dd>{n?.summary ?? n?.state.summary ?? g?.summary}</dd>
          </>
        )}
      </dl>
      {pending.map((a) => (
        <AttentionCard key={a.requestId} item={a} />
      ))}
      {events.length > 0 && (
        <ul className="ent-events">
          {events.map(({ e, title }) => (
            <li key={e.seq}>
              <time className="mono">{fmtTime(e.ts)}</time>
              <span className="truncate">{title}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="ent-actions">
        <Link to={`${page}&dtab=trace`} className="btn btn-sm">
          <ScrollText />
          执行详情
        </Link>
        <Link to={page} className="btn btn-sm">
          <SquareArrowOutUpRight />
          在运行页打开
        </Link>
      </div>
      {!inPanel && <EntityFoot target={target} live={isLive(status)} at={n?.state.endedAt ?? started} />}
    </div>
  )
}
