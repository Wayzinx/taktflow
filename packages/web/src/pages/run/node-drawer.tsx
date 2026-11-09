import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { ClipboardCheck, FileDiff, FileInput, Fingerprint, Layers, ListChecks, ListTree, MessageSquareText, Scale, ScanSearch, ScrollText, ShieldCheck, X } from 'lucide-react'
import type { Expansion, GraphNode } from '@taktflow/core'
import { useAsync } from '../../api'
import { ErrorState, KindIcon, Skeleton, StatusBadge, TabPanel, Tabs, type TabDef } from '../../components/ui'
import { askSteward } from '../../lib/ui-store'
import { setQuery, useLocation } from '../../lib/router'
import { NODE_STATUS } from '../../lib/status'
import { nodeLabel } from './node-label'
import { ContextTab, GateTab, IoTab, JudgeTab, OverviewTab, PromptTab, TraceTab } from './drawer-tabs'
import { CompletionTab } from './completion-tab'
import { NodeBrief } from './node-brief'
import { RecipeSection } from './recipe-section'
import { ReviewTab } from './review/review-tab'
import { CheckpointsTab } from './checkpoints-tab'
import { ChangesCard } from './changes/changes-card'
import './drawer.css'
import { BeeGlyph } from '../../components/identity'
import { AgentMark, harnessHue, markOf } from '../../components/agent-mark'

const MIN_W = 440
const DEFAULT_W = 580

function useDrawerWidth(): [number, (e: ReactMouseEvent) => void] {
  const [w, setW] = useState(() => {
    try {
      return Number(localStorage.getItem('takt.drawer.w')) || DEFAULT_W
    } catch {
      return DEFAULT_W
    }
  })
  useEffect(() => {
    document.documentElement.style.setProperty('--drawer-w', `${w}px`)
  }, [w])
  const start = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = w
    const move = (ev: MouseEvent) => setW(Math.max(MIN_W, Math.min(window.innerWidth * 0.85, startW + startX - ev.clientX)))
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
      setW((cur) => {
        try {
          localStorage.setItem('takt.drawer.w', String(Math.round(cur)))
        } catch {
          // 存不下就不记
        }
        return cur
      })
    }
    document.body.classList.add('resizing')
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  return [w, start]
}

export function NodeDrawer({ runId, requirementId, nodeId, graphNode, expansions, liveTick, closing = false }: { runId: string; requirementId: string; nodeId: string; graphNode?: GraphNode; expansions: Expansion[]; liveTick: number; closing?: boolean }) {
  const { query } = useLocation()
  const q = useAsync((ds) => ds.node(runId, nodeId), [runId, nodeId, liveTick])
  const [width, startResize] = useDrawerWidth()
  const lastData = useRef(q.data)
  if (q.data) lastData.current = q.data
  // liveTick 刷新时保留上一份数据，避免抽屉闪成骨架
  const d = q.data ?? (lastData.current?.state.id === nodeId ? lastData.current : undefined)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setQuery({ node: undefined, dtab: undefined })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tabs: TabDef[] = [
    { id: 'overview', label: '概览', icon: ListTree },
    { id: 'completion', label: '完成标准', icon: ListChecks, hidden: !d || !(d.completion?.length || d.completionChecks?.length || d.failures?.length), count: d?.completion?.length },
    { id: 'io', label: '输入输出', icon: FileInput, count: d ? d.inputs.length + d.outputs.length : undefined },
    { id: 'trace', label: 'Trace', icon: ScrollText, count: d?.events.length },
    { id: 'context', label: '上下文', icon: Layers, hidden: !d || d.context.snapshots.length === 0 },
    { id: 'judge', label: '判决', icon: Scale, hidden: d?.kind !== 'judge', count: d?.verdicts?.length },
    { id: 'gate', label: '门禁', icon: ShieldCheck, hidden: d?.kind !== 'gate' },
    { id: 'review', label: '评审', icon: ClipboardCheck, hidden: d?.kind !== 'review', count: d?.review?.rounds.length },
    { id: 'checkpoints', label: '检查点', icon: ScanSearch, hidden: !d?.checkpoints?.length, count: d?.checkpoints?.length },
    { id: 'changes', label: '改动', icon: FileDiff, hidden: !d?.changes?.files.length, count: d?.changes?.files.length },
    { id: 'prompt', label: 'Prompt', icon: MessageSquareText, hidden: !d?.prompt },
    { id: 'recipe', label: '配方', icon: Fingerprint, hidden: !d?.recipe },
  ]
  const visible = tabs.filter((t) => !t.hidden).map((t) => t.id)
  const requested = query.get('dtab') ?? 'overview'
  const tab = visible.includes(requested) ? requested : 'overview'
  const kind = d?.kind ?? graphNode?.kind
  const status = d?.state.status ?? graphNode?.status
  const title = graphNode ? nodeLabel(graphNode, expansions).title : d?.title

  return (
    <aside className={`drawer${closing ? ' closing' : ''}`} style={{ width } as CSSProperties} aria-label="节点详情" inert={closing || undefined}>
      <div className="drawer-resize" onMouseDown={startResize} title="拖动调整宽度" />
      <div className="drawer-head">
        {/* 换节点时标题与摘要交叉淡化（150ms），不是硬切 */}
        <TabPanel key={nodeId} className="drawer-node-swap">
        <div className="drawer-title-row">
          {kind === 'agent' || kind === 'judge' ? (
            <AgentMark {...markOf(status ?? 'pending')} role={d?.role ?? graphNode?.role ?? (kind === 'judge' ? 'judge' : undefined)} hue={harnessHue(graphNode?.harness)} size={32} label={`${d?.role ?? graphNode?.role ?? kind} · ${graphNode?.harness ?? ''}`} />
          ) : (
            kind && <KindIcon kind={kind} size={28} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="drawer-title truncate">{title ?? <Skeleton w={160} h={16} />}</div>
            <div className="drawer-sub">
              <span className="mono truncate">{nodeId}</span>
              {(d?.role ?? graphNode?.role) && <span className="mono">{d?.role ?? graphNode?.role}</span>}
              {graphNode?.harness && <span className="mono">{graphNode.harness}</span>}
            </div>
          </div>
          {status && <StatusBadge meta={NODE_STATUS[status]} />}
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => askSteward(status === 'failed' || status === 'blocked' ? `${title ?? nodeId} 为什么${status === 'failed' ? '失败' : '卡住'}了？该怎么处理？` : `${title ?? nodeId} 现在怎么样了？`, [{ type: 'node', id: nodeId, parent: runId, label: title ?? nodeId }, { type: 'run', id: runId, label: runId }])}
            aria-label="问管家这个节点"
            title="问管家这个节点"
          >
            <BeeGlyph />
          </button>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setQuery({ node: undefined, dtab: undefined })} aria-label="关闭" title="关闭（Esc）">
            <X />
          </button>
        </div>
        <NodeBrief d={d} graphNode={graphNode} runId={runId} requirementId={requirementId} title={title ?? nodeId} liveTick={liveTick} />
        </TabPanel>
        <Tabs size="sm" tabs={tabs} value={tab} onChange={(t) => setQuery({ dtab: t === 'overview' ? undefined : t })} />
      </div>
      <div className="drawer-body">
        {q.error && !d ? (
          <ErrorState error={q.error} onRetry={q.reload} />
        ) : !d ? (
          <div style={{ display: 'grid', gap: 12, padding: 20 }}>
            <Skeleton w="60%" h={14} />
            <Skeleton w="90%" h={11} />
            <Skeleton w="80%" h={11} />
            <Skeleton h={90} style={{ marginTop: 8 }} />
          </div>
        ) : (
          <TabPanel className="drawer-pane" key={`${nodeId}/${tab}`}>
            {tab === 'overview' && <OverviewTab d={d} runId={runId} requirementId={requirementId} />}
            {tab === 'completion' && <CompletionTab d={d} runId={runId} requirementId={requirementId} />}
            {tab === 'io' && <IoTab d={d} requirementId={requirementId} />}
            {tab === 'trace' && <TraceTab d={d} at={query.get('at') ?? undefined} />}
            {tab === 'context' && <ContextTab d={d} />}
            {tab === 'judge' && <JudgeTab d={d} runId={runId} requirementId={requirementId} />}
            {tab === 'gate' && <GateTab d={d} />}
            {tab === 'review' && <ReviewTab d={d} runId={runId} requirementId={requirementId} />}
            {tab === 'checkpoints' && <CheckpointsTab d={d} runId={runId} />}
            {tab === 'changes' && d.changes && (
              <div className="dpad">
                <ChangesCard runId={runId} nodeId={nodeId} nodeTitle={title ?? nodeId} changes={d.changes} limit={50} bare />
              </div>
            )}
            {tab === 'prompt' && <PromptTab d={d} />}
            {tab === 'recipe' && <RecipeSection recipe={d.recipe} />}
          </TabPanel>
        )}
      </div>
    </aside>
  )
}
