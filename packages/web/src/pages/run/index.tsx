import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Crosshair, Fingerprint, GanttChartSquare, Map as MapIcon, Maximize2, OctagonX, Play, RotateCw, Square, Unplug, Workflow } from 'lucide-react'
import type { RunDetail } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { useCrumbs } from '../../components/layout'
import { StageRail } from '../../components/stage-rail'
import { CountUp, ErrorState, Segmented, Skeleton, StatusBadge, SuggestionChips, toast, useStewardSuggestions } from '../../components/ui'
import { fmtCost, fmtDate, fmtDuration, fmtTokens, totalTokens } from '../../lib/format'
import { Link, setQuery, useLocation } from '../../lib/router'
import { NODE_STATUS, runStatusMeta } from '../../lib/status'
import { useIsDark } from '../../lib/theme'
import { layoutRun, type FlowNode } from './dag-layout'
import { decorate, useCompletionPulses, useReplay } from './canvas-motion'
import { nodeTypes } from './dag-nodes'
import { edgeTypes } from './dag-edges'
import { EventTicker } from '../../components/event-ticker'
import { NodeDrawer } from './node-drawer'
import { RunCounters } from './run-counters'
import { TimeView } from './time/time-view'
import './run.css'
import './run-motion.css'
import { onTabReturn } from '../../lib/visible'

/** 整数读数：过渡中途也按整数显示（CountUp 默认格式会在中途露出小数）。 */

/** 图例和右上角工具条大约占 52px，fitView 时顶部至少留这么多，泳道列头才不会被盖住。 */
const PANEL_CLEARANCE = 60

/** 小地图默认收起（会挡住左下角的画布内容），开关按浏览器记住。 */
function useMiniMapPref(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem('takt.minimap') === '1'
    } catch {
      return false
    }
  })
  const set = (v: boolean) => {
    setOn(v)
    try {
      localStorage.setItem('takt.minimap', v ? '1' : '0')
    } catch {
      // 存不下就只在本页生效
    }
  }
  return [on, set]
}

type RunView = 'canvas' | 'time'

/** 画布 / 时间切换（docs/design/26 §2）：两个视图在同一位置放同一个开关，写进 URL 的 view。 */
function ViewSwitch({ value }: { value: RunView }) {
  return (
    <Segmented<RunView>
      size="sm"
      ariaLabel="运行视图"
      value={value}
      onChange={(v) => setQuery({ view: v === 'canvas' ? undefined : v })}
      options={[
        { value: 'canvas', label: '画布', icon: Workflow },
        { value: 'time', label: '时间', icon: GanttChartSquare },
      ]}
    />
  )
}

/** 抽屉收起动画的时长，与 run-motion.css 的 drawer-out 保持一致。 */
const DRAWER_EXIT_MS = 160

/** 关抽屉时让它多留一会儿播完收起动画；切换节点则立即换内容。 */
function useLinger(id: string | undefined, ms: number): { id?: string; closing: boolean } {
  const [last, setLast] = useState(id)
  useEffect(() => {
    if (id) {
      setLast(id)
      return
    }
    const t = setTimeout(() => setLast(undefined), ms)
    return () => clearTimeout(t)
  }, [id, ms])
  if (id) return { id, closing: false }
  return { id: last, closing: last !== undefined }
}

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
  const stageFocus = query.get('stage') ?? undefined
  const view: RunView = query.get('view') === 'time' ? 'time' : 'canvas'
  const suggestions = useStewardSuggestions('run', runId)
  const q = useAsync((s) => s.run(runId), [runId])
  const audit = useAsync((s) => s.audit(runId), [runId])
  const [liveTick, setLiveTick] = useState(0)
  // 头部用量取 server 的 RunSummary.usage（与运行列表、需求页同一口径），web 不自己累加。
  // 过渡做法：RunDetail 还没有 usage（已提协议变更请求），先从该需求的运行列表里取；协议加上后删掉这段。
  const reqId = q.data?.run.requirementId
  const summary = useAsync((s) => (reqId ? s.runs(reqId).then((rs) => rs.find((r) => r.runId === runId)) : Promise.resolve(undefined)), [runId, reqId])
  const reload = useRef({ run: q.reload, usage: summary.reload })
  reload.current = { run: q.reload, usage: summary.reload }

  // SSE：每来一条事件，节流刷新运行图；抽屉按 liveTick 刷新。已结束的运行不再订阅，免得空占一条长连接。
  // server 的运行用量只累加 node.finished，所以只有这类事件之后才重拉用量（它要读整个需求的事件日志）。
  const live = q.data ? q.data.run.status === 'running' || q.data.run.status === 'waiting_human' : false
  useEffect(() => {
    if (!live) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let usageDirty = false
    const off = ds.subscribe(runId, (e) => {
      if (e.type === 'node.finished') usageDirty = true
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        reload.current.run()
        if (usageDirty) reload.current.usage()
        usageDirty = false
        setLiveTick((t) => t + 1)
      }, 400)
    })
    // 后台标签页断开过流：回来时重拉一次（从没收到过事件时没有游标可补）
    const offReturn = onTabReturn(() => {
      reload.current.run()
      setLiveTick((t) => t + 1)
    })
    return () => {
      off()
      offReturn()
      if (timer) clearTimeout(timer)
    }
  }, [ds, runId, live])
  // 运行刚结束：订阅已关，补拉一次，接住收尾时晚于事件落盘的状态
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live) {
      const timer = setTimeout(() => { reload.current.run(); setLiveTick((t) => t + 1) }, 800)
      wasLive.current = live
      return () => clearTimeout(timer)
    }
    wasLive.current = live
  }, [live])

  const d = q.data
  useCrumbs(
    [
      { label: '需求', to: '/requirements' },
      { label: d ? <span className="mono">{d.run.requirementId}</span> : <Skeleton w={56} h={10} />, to: d ? `/req/${d.run.requirementId}?tab=runs` : undefined },
      { label: <span className="mono">{runId}</span> },
    ],
    [runId, d?.run.requirementId],
  )
  const running = d?.run.status === 'running' && !d.interrupted
  const now = useNow(running)
  const stages = d?.stages ?? []
  const drawer = useLinger(selected, DRAWER_EXIT_MS)

  if (q.error && !d) return <ErrorState error={q.error} onRetry={q.reload} />

  const counts = d
    ? {
        done: d.graph.nodes.filter((n) => n.status === 'succeeded' || n.status === 'skipped').length,
        total: d.graph.nodes.length,
        failed: d.graph.nodes.filter((n) => n.status === 'failed' || n.status === 'blocked').length,
        usage: summary.data?.usage,
      }
    : undefined

  return (
    <div className="run-page">
      <header className="run-header">
        <div className="run-title-row">
          <h1 className="run-title">{d ? d.workflow.title : <Skeleton w={160} h={18} />}</h1>
          {d && <span className="mono run-wf">{d.workflow.id}@{d.workflow.version}</span>}
          {d && <StatusBadge meta={runStatusMeta(d.run.status, d.interrupted)} />}
          {d && <RunCounters detail={d} />}
          <span style={{ flex: 1 }} />
          {d && counts && (
            <div className="run-facts">
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
                  <CountUp value={counts.done} />/{counts.total}
                  {counts.failed > 0 && <b style={{ color: 'var(--st-failed)' }}> · {counts.failed} 失败</b>}
                </span>
              </span>
              <span>
                <label>Token</label>
                <span className="mono num">{counts.usage ? fmtTokens(totalTokens(counts.usage)) : '—'}</span>
              </span>
              <span>
                <label>成本</label>
                <span className="mono num">{fmtCost(counts.usage?.costUsd)}</span>
              </span>
              {audit.data && (
                <span className={`audit-pill${audit.data.ok ? '' : ' broken'}`} title="事件日志的哈希链校验：完整表示运行记录没有被改动过">
                  <Fingerprint />
                  {audit.data.ok ? '哈希链完整' : `断链 #${audit.data.brokenAt}`}
                </span>
              )}
            </div>
          )}
        </div>
        {d && (d.interrupted || d.run.status === 'failed') && <RecoveryBar detail={d} onDone={q.reload} />}
        <div className="run-stage-row">
          {d ? <StageRail size="sm" stages={stages} empty="这个流程没有划分阶段" onStage={(id) => setQuery({ stage: id === stageFocus ? undefined : id })} activeId={stageFocus} /> : <Skeleton h={26} />}
        </div>
        {d && suggestions.length > 0 && <SuggestionChips className="run-suggest" items={suggestions} context={[{ type: 'run', id: runId, label: runId }]} />}
      </header>
      <div className="run-body">
        {!d ? (
          <div className="run-canvas-skeleton">
            <Skeleton w="100%" h={9999} r={0} />
          </div>
        ) : view === 'time' ? (
          <div key="time" className="run-view">
            <TimeView runId={runId} detail={d} liveTick={liveTick} selected={selected} toolbar={<ViewSwitch value="time" />} />
          </div>
        ) : (
          <div key="canvas" className="run-view">
            <RunCanvas detail={d} selected={selected} stageFocus={stageFocus} />
          </div>
        )}
        {d && drawer.id && d.run.nodes[drawer.id] && (
          <NodeDrawer closing={drawer.closing} runId={runId} requirementId={d.run.requirementId} nodeId={drawer.id} graphNode={d.graph.nodes.find((n) => n.id === drawer.id)} expansions={d.run.expansions} liveTick={liveTick} />
        )}
      </div>
      {d && <EventTicker runId={runId} live={live} liveTick={liveTick} onLocate={(node) => setQuery({ node, dtab: undefined })} />}
    </div>
  )
}

/**
 * 运行停住了时的恢复条：
 * - 中断（状态还是 running，但没有进程在执行，serve 重启或崩溃留下的）→ 继续运行（run.resume）
 * - 失败 → 列出失败 / 阻塞的节点和原因，重试这些节点（run.retry），不必整个运行从头来
 */
function RecoveryBar({ detail, onDone }: { detail: RunDetail; onDone: () => void }) {
  const ds = useSource()
  const [busy, setBusy] = useState(false)
  const runId = detail.run.runId
  const nodes = Object.values(detail.run.nodes)
  const mode = detail.interrupted ? 'interrupted' : 'failed'
  const targets = (mode === 'interrupted' ? nodes.filter((n) => n.status === 'running') : nodes.filter((n) => n.status === 'failed' || n.status === 'blocked')).map((n) => n.id)
  const firstError = mode === 'failed' ? nodes.find((n) => targets.includes(n.id) && n.error)?.error : undefined
  const act = async () => {
    setBusy(true)
    try {
      const r =
        mode === 'interrupted'
          ? await ds.runCommand('run.resume', { input: { runId }, reason: `继续被中断的运行 ${runId}` })
          : await ds.runCommand('run.retry', { input: { runId }, reason: `重试失败的节点：${targets.join('、')}` })
      if (!r.ok) throw new Error(r.message)
      toast(mode === 'interrupted' ? '已继续运行' : '已开始重试', { body: targets.length ? `从 ${targets.join('、')} 重新开始。` : undefined })
      onDone()
    } catch (e) {
      toast(mode === 'interrupted' ? '没继续成' : '没重试成', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const Icon = mode === 'interrupted' ? Unplug : OctagonX
  return (
    <div className="run-recover" data-mode={mode} role="status">
      <Icon aria-hidden />
      <span className="run-recover-text">
        {mode === 'interrupted' ? (
          <>
            <b>运行中断了</b>：没有进程在执行它，通常是 serve 重启或崩溃时停下的。
            {targets.length > 0 && (
              <>
                停在 <span className="mono">{targets.join('、')}</span>，继续会从这里重跑。
              </>
            )}
          </>
        ) : (
          <>
            <b>运行失败</b>
            {targets.length > 0 && (
              <>
                ：<span className="mono">{targets.join('、')}</span>
                {firstError ? <span className="run-recover-error" title={firstError}> · {firstError}</span> : null}
              </>
            )}
            。前面成功的节点会保留，只重跑这些。
          </>
        )}
      </span>
      {(mode === 'interrupted' || targets.length > 0) && (
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act()}>
          {mode === 'interrupted' ? <Play aria-hidden /> : <RotateCw aria-hidden />}
          {busy ? (mode === 'interrupted' ? '继续中…' : '重试中…') : mode === 'interrupted' ? '继续运行' : '重试失败的节点'}
        </button>
      )}
    </div>
  )
}

function RunCanvas({ detail, selected, stageFocus }: { detail: RunDetail; selected?: string; stageFocus?: string }) {
  const dark = useIsDark()
  const stages = useMemo(() => detail.stages ?? [], [detail])
  const layout = useMemo(() => layoutRun(detail.graph, detail.workflow.stages, stages, detail.run.expansions, selected), [detail, stages, selected])
  const [miniMap, setMiniMap] = useMiniMapPref()
  const rf = useRef<ReactFlowInstance<FlowNode> | null>(null)
  const drawerOpen = Boolean(selected)
  // 动效状态（docs/design/27 §2.1）：悬停的上下游、刚完成节点的交接信号、回放
  const [hover, setHover] = useState<string>()
  const pulses = useCompletionPulses(detail.graph.nodes)
  const replay = useReplay(detail)
  const focus = hover ?? selected
  const view = useMemo(() => decorate(layout, focus, pulses, replay), [layout, focus, pulses, replay])

  function focusStage(instance: ReactFlowInstance<FlowNode>, animate: boolean, pick?: string) {
    const sel = selected ? detail.graph.nodes.find((n) => n.id === selected) : undefined
    const active = stages.find((s) => s.status === 'running' || s.status === 'waiting_human' || s.status === 'failed')
    const loopStage = detail.graph.nodes.find((n) => n.kind === 'loop')?.stage
    const stageId = pick ?? sel?.stage ?? active?.id ?? loopStage ?? stages[stages.length - 1]?.id
    const ids = stageId ? (layout.stageNodes.get(stageId) ?? []) : []
    void instance.fitView({
      nodes: [...ids, `__lane__/${stageId}`].map((id) => ({ id })),
      padding: { top: `${PANEL_CLEARANCE}px`, bottom: '24px', left: '48px', right: drawerOpen ? '620px' : '48px' },
      maxZoom: 1,
      minZoom: 0.45,
      duration: animate ? 400 : 0,
    })
  }

  // 阶段条点了某个阶段：画布平移缩放到该泳道（400ms，与 fitView 其他入口同速）
  const focusRef = useRef(focusStage)
  focusRef.current = focusStage
  useEffect(() => {
    if (stageFocus && rf.current) focusRef.current(rf.current, true, stageFocus)
  }, [stageFocus])
  // 回放时画布跟着在跑的阶段走，结束后回到原来的聚焦
  const replayStage = replay.playing ? detail.graph.nodes.find((n) => n.stage && replay.phaseOf(n.id) === 'run')?.stage : undefined
  useEffect(() => {
    if (replayStage && rf.current) focusRef.current(rf.current, true, replayStage)
  }, [replayStage])

  return (
    <div className={`run-canvas${hover ? ' has-focus' : selected ? ' has-sel' : ''}${replay.playing ? ' is-replay' : ''}`}>
      <ReactFlow<FlowNode>
        nodes={view.nodes}
        edges={view.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={dark ? 'dark' : 'light'}
        onInit={(i) => {
          rf.current = i
          focusStage(i, false, stageFocus)
        }}
        onNodeClick={(_, n) => {
          if (n.type === 'lane') return
          const id = n.id.startsWith('__expand__/') ? n.id.slice('__expand__/'.length) : n.id
          setQuery({ node: id === selected ? undefined : id, dtab: undefined })
        }}
        onPaneClick={() => selected && setQuery({ node: undefined, dtab: undefined })}
        onNodeMouseEnter={(_, n) => n.type === 'dag' && setHover(n.id)}
        onNodeMouseLeave={() => setHover(undefined)}
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
        {miniMap && (
        <MiniMap
          pannable
          zoomable
          position="bottom-left"
          style={{ marginLeft: 56, width: 168, height: 104 }}
          nodeClassName={(n) => (n.type === 'lane' ? 'mm-lane' : n.type === 'group' ? 'mm-group' : `mm-${NODE_STATUS[(n.data as { node: { status: keyof typeof NODE_STATUS } }).node.status].tone}`)}
          nodeBorderRadius={4}
          maskColor="var(--mm-mask)"
        />
        )}
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
          <span>
            <i className="lg-rework" />
            打回
          </span>
        </Panel>
        <Panel position="top-right" className="dag-tools" style={{ marginRight: drawerOpen ? 'calc(var(--drawer-w, 560px) + 16px)' : undefined }}>
          <ViewSwitch value="canvas" />
          {replay.available && (
            <button
              className={`btn btn-sm${replay.playing ? ' on' : ''}`}
              onClick={() => (replay.playing ? replay.stop() : replay.start())}
              title={replay.playing ? '停止回放' : '把这次运行按真实先后压到 6 秒重演一遍'}
              aria-pressed={replay.playing}
              style={{ '--p': replay.progress } as CSSProperties}
            >
              {replay.playing ? <Square /> : <Play />}
              {replay.playing ? '停止' : '回放'}
            </button>
          )}
          <button className={`btn btn-sm${miniMap ? ' on' : ''}`} onClick={() => setMiniMap(!miniMap)} title={miniMap ? '隐藏小地图' : '显示小地图'} aria-pressed={miniMap}>
            <MapIcon />
            小地图
          </button>
          <button className="btn btn-sm" onClick={() => rf.current && focusStage(rf.current, true)} title="聚焦当前阶段">
            <Crosshair />
            聚焦
          </button>
          <button className="btn btn-sm" onClick={() => void rf.current?.fitView({ padding: { top: `${PANEL_CLEARANCE}px`, bottom: '24px', left: '24px', right: drawerOpen ? '600px' : '24px' }, duration: 400 })} title="适应视图">
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
        画布展示这次运行用的流程快照；要改流程去 Workflow 编辑器
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

