import { useEffect, useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Crosshair, Fingerprint, Maximize2 } from 'lucide-react'
import type { RunDetail } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { useCrumbs } from '../../components/layout'
import { StageBar } from '../../components/stage-bar'
import { ErrorState, Skeleton, StatusBadge } from '../../components/ui'
import { fmtCost, fmtDate, fmtDuration, fmtTokens, totalTokens } from '../../lib/format'
import { Link, setQuery, useLocation } from '../../lib/router'
import { computeStages } from '../../lib/stage'
import { NODE_STATUS, RUN_STATUS } from '../../lib/status'
import { useIsDark } from '../../lib/theme'
import { layoutRun, type FlowNode } from './dag-layout'
import { nodeTypes } from './dag-nodes'
import { NodeDrawer } from './node-drawer'
import './run.css'

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function RunPage({ runId }: { runId: string }) {
  const ds = useSource()
  const { query } = useLocation()
  const selected = query.get('node') ?? undefined
  const q = useAsync((s) => s.run(runId), [runId])
  const audit = useAsync((s) => s.audit(runId), [runId])
  const [liveTick, setLiveTick] = useState(0)
  const reload = useRef(q.reload)
  reload.current = q.reload

  // SSE：每来一条事件，节流刷新运行图；抽屉按 liveTick 刷新
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = ds.subscribe(runId, () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        reload.current()
        setLiveTick((t) => t + 1)
      }, 400)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [ds, runId])

  const d = q.data
  useCrumbs(
    [
      { label: '需求', to: '/requirements' },
      { label: <span className="mono">{d?.run.requirementId ?? '…'}</span>, to: d ? `/req/${d.run.requirementId}?tab=runs` : undefined },
      { label: <span className="mono">{runId}</span> },
    ],
    [runId, d?.run.requirementId],
  )
  const running = d?.run.status === 'running'
  const now = useNow(running)
  const stages = useMemo(() => (d ? computeStages(d.workflow.stages, d.graph.nodes) : []), [d])

  if (q.error && !d) return <ErrorState error={q.error} onRetry={q.reload} />

  const counts = d
    ? {
        done: d.graph.nodes.filter((n) => n.status === 'succeeded' || n.status === 'skipped').length,
        total: d.graph.nodes.length,
        failed: d.graph.nodes.filter((n) => n.status === 'failed' || n.status === 'blocked').length,
        usage: d.graph.nodes.reduce((s, n) => s + totalTokens(n.usage), 0),
        cost: d.graph.nodes.reduce((s, n) => s + (n.usage?.costUsd ?? 0), 0),
      }
    : undefined

  return (
    <div className="run-page">
      <header className="run-header">
        <div className="run-title-row">
          <h1 className="run-title">{d ? d.workflow.title : <Skeleton w={160} h={18} />}</h1>
          {d && <span className="mono run-wf">{d.workflow.id}@{d.workflow.version}</span>}
          {d && <StatusBadge meta={RUN_STATUS[d.run.status]} />}
          <span style={{ flex: 1 }} />
          {d && counts && (
            <div className="run-facts">
              <span>
                <label>运行</label>
                <span className="mono">{runId}</span>
              </span>
              <span>
                <label>开始</label>
                <span className="mono">{fmtDate(d.run.startedAt)}</span>
              </span>
              <span>
                <label>耗时</label>
                <span className="mono num">{fmtDuration((d.run.endedAt ? Date.parse(d.run.endedAt) : now) - Date.parse(d.run.startedAt))}</span>
              </span>
              <span>
                <label>节点</label>
                <span className="mono num">
                  {counts.done}/{counts.total}
                  {counts.failed > 0 && <b style={{ color: 'var(--st-failed)' }}> · {counts.failed} 失败</b>}
                </span>
              </span>
              <span>
                <label>Token</label>
                <span className="mono num">{fmtTokens(counts.usage)}</span>
              </span>
              <span>
                <label>成本</label>
                <span className="mono num">{fmtCost(counts.cost)}</span>
              </span>
              {audit.data && (
                <span className={`audit-pill${audit.data.ok ? '' : ' broken'}`} title="events.jsonl 哈希链校验（takt audit verify）">
                  <Fingerprint />
                  {audit.data.ok ? '哈希链完整' : `断链 #${audit.data.brokenAt}`}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="run-stage-row">{d ? <StageBar stages={stages} variant="full" /> : <Skeleton h={26} />}</div>
      </header>
      <div className="run-body">
        {d ? <RunCanvas detail={d} selected={selected} /> : <div className="run-canvas-skeleton"><Skeleton w="100%" h={9999} r={0} /></div>}
        {d && selected && d.run.nodes[selected] && <NodeDrawer runId={runId} requirementId={d.run.requirementId} nodeId={selected} graphNode={d.graph.nodes.find((n) => n.id === selected)} liveTick={liveTick} />}
      </div>
    </div>
  )
}

function RunCanvas({ detail, selected }: { detail: RunDetail; selected?: string }) {
  const dark = useIsDark()
  const stages = useMemo(() => computeStages(detail.workflow.stages, detail.graph.nodes), [detail])
  const layout = useMemo(() => layoutRun(detail.graph, detail.workflow.stages, stages, selected), [detail, stages, selected])
  const rf = useRef<ReactFlowInstance<FlowNode> | null>(null)
  const drawerOpen = Boolean(selected)

  function focusStage(instance: ReactFlowInstance<FlowNode>, animate: boolean) {
    const sel = selected ? detail.graph.nodes.find((n) => n.id === selected) : undefined
    const active = stages.find((s) => s.status === 'running' || s.status === 'waiting_human' || s.status === 'failed')
    const loopStage = detail.graph.nodes.find((n) => n.kind === 'loop')?.stage
    const stageId = sel?.stage ?? active?.id ?? loopStage ?? stages[stages.length - 1]?.id
    const ids = stageId ? (layout.stageNodes.get(stageId) ?? []) : []
    void instance.fitView({
      nodes: [...ids, `__lane__/${stageId}`].map((id) => ({ id })),
      padding: { top: '24px', bottom: '24px', left: '48px', right: drawerOpen ? '620px' : '48px' },
      maxZoom: 1,
      minZoom: 0.45,
      duration: animate ? 400 : 0,
    })
  }

  return (
    <div className="run-canvas">
      <ReactFlow<FlowNode>
        nodes={layout.nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        colorMode={dark ? 'dark' : 'light'}
        onInit={(i) => {
          rf.current = i
          focusStage(i, false)
        }}
        onNodeClick={(_, n) => {
          if (n.type === 'lane') return
          const id = n.id.startsWith('__expand__/') ? n.id.slice('__expand__/'.length) : n.id
          setQuery({ node: id === selected ? undefined : id, dtab: undefined })
        }}
        onPaneClick={() => selected && setQuery({ node: undefined, dtab: undefined })}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        panOnScroll
        zoomOnDoubleClick={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--grid-dot)" />
        <MiniMap
          pannable
          zoomable
          position="bottom-left"
          style={{ marginLeft: 56 }}
          nodeClassName={(n) => (n.type === 'lane' ? 'mm-lane' : n.type === 'group' ? 'mm-group' : `mm-${NODE_STATUS[(n.data as { node: { status: keyof typeof NODE_STATUS } }).node.status].tone}`)}
          nodeBorderRadius={4}
          maskColor="var(--mm-mask)"
        />
        <Controls showInteractive={false} position="bottom-left" />
        <Panel position="top-left" className="dag-legend">
          <span>
            <i className="lg-dep" />
            依赖
          </span>
          <span>
            <i className="lg-route" />
            判决路由
          </span>
          <span>
            <i className="lg-expand" />
            动态展开
          </span>
        </Panel>
        <Panel position="top-right" className="dag-tools" style={{ marginRight: drawerOpen ? 'calc(var(--drawer-w, 560px) + 16px)' : undefined }}>
          <button className="btn btn-sm" onClick={() => rf.current && focusStage(rf.current, true)} title="聚焦当前阶段">
            <Crosshair />
            聚焦
          </button>
          <button className="btn btn-sm" onClick={() => void rf.current?.fitView({ padding: { top: '24px', bottom: '24px', left: '24px', right: drawerOpen ? '600px' : '24px' }, duration: 400 })} title="适应视图">
            <Maximize2 />
            全部
          </button>
        </Panel>
      </ReactFlow>
      <RunFootnote detail={detail} />
    </div>
  )
}

function RunFootnote({ detail }: { detail: RunDetail }) {
  const exp = detail.run.expansions[0]
  return (
    <div className="run-footnote">
      <span>
        workflow 即代码 · 画布只读结构，结构改动走代码评审 · 快照 <span className="mono">runs/{detail.run.runId}/workflow.json</span>
      </span>
      {exp && (
        <span>
          · planner <span className="mono">{exp.plannerId}</span> 展开 {exp.items.length} 个条目
        </span>
      )}
      <Link to={`/req/${detail.run.requirementId}?tab=activity`} className="run-footnote-link">
        审计日志 →
      </Link>
    </div>
  )
}

