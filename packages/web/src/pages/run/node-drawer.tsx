import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { Bot, FileInput, Layers, ListTree, Scale, ScrollText, ShieldCheck, X } from 'lucide-react'
import type { Expansion, GraphNode } from '@taktflow/core'
import { useAsync } from '../../api'
import { ErrorState, KindIcon, Skeleton, StatusBadge, Tabs, type TabDef } from '../../components/ui'
import { setQuery, useLocation } from '../../lib/router'
import { NODE_STATUS } from '../../lib/status'
import { nodeLabel } from './node-label'
import { ContextTab, GateTab, IoTab, JudgeTab, OverviewTab, PromptTab, TraceTab } from './drawer-tabs'
import './drawer.css'

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
    { id: 'io', label: '输入输出', icon: FileInput, count: d ? d.inputs.length + d.outputs.length : undefined },
    { id: 'trace', label: 'Trace', icon: ScrollText, count: d?.events.length },
    { id: 'context', label: '上下文', icon: Layers, hidden: !d || d.context.snapshots.length === 0 },
    { id: 'judge', label: '判决', icon: Scale, hidden: d?.kind !== 'judge', count: d?.verdicts?.length },
    { id: 'gate', label: '门禁', icon: ShieldCheck, hidden: d?.kind !== 'gate' },
    { id: 'prompt', label: 'Prompt', icon: Bot, hidden: !d?.prompt },
  ]
  const visible = tabs.filter((t) => !t.hidden).map((t) => t.id)
  const requested = query.get('dtab') ?? 'overview'
  const tab = visible.includes(requested) ? requested : 'overview'
  const kind = d?.kind ?? graphNode?.kind
  const status = d?.state.status ?? graphNode?.status

  return (
    <aside className={`drawer${closing ? ' closing' : ''}`} style={{ width } as CSSProperties} aria-label="节点详情" inert={closing || undefined}>
      <div className="drawer-resize" onMouseDown={startResize} title="拖动调整宽度" />
      <div className="drawer-head">
        <div className="drawer-title-row">
          {kind && <KindIcon kind={kind} size={28} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="drawer-title truncate">{graphNode ? nodeLabel(graphNode, expansions).title : (d?.title ?? <Skeleton w={160} h={16} />)}</div>
            <div className="drawer-sub">
              <span className="mono truncate">{nodeId}</span>
              {(d?.role ?? graphNode?.role) && <span className="mono">{d?.role ?? graphNode?.role}</span>}
              {graphNode?.harness && <span className="mono">{graphNode.harness}</span>}
            </div>
          </div>
          {status && <StatusBadge meta={NODE_STATUS[status]} />}
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setQuery({ node: undefined, dtab: undefined })} aria-label="关闭" title="关闭（Esc）">
            <X />
          </button>
        </div>
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
          <div className="drawer-pane fade-in" key={tab}>
            {tab === 'overview' && <OverviewTab d={d} runId={runId} requirementId={requirementId} />}
            {tab === 'io' && <IoTab d={d} requirementId={requirementId} />}
            {tab === 'trace' && <TraceTab d={d} />}
            {tab === 'context' && <ContextTab d={d} />}
            {tab === 'judge' && <JudgeTab d={d} runId={runId} requirementId={requirementId} />}
            {tab === 'gate' && <GateTab d={d} />}
            {tab === 'prompt' && <PromptTab d={d} />}
          </div>
        )}
      </div>
    </aside>
  )
}
