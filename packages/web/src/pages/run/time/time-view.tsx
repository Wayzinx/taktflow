import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronRight, RotateCcw } from 'lucide-react'
import type { NodeStatus, RunDetail, RunTimeline } from '@taktflow/core'
import { useAsync } from '../../../api'
import { useSecondTick } from '../../../components/activity-line'
import { harnessHue } from '../../../components/agent-mark'
import { ErrorState, Skeleton } from '../../../components/ui'
import { toolAction } from '../../../lib/actions'
import { fmtDuration, fmtTime, fmtTokens } from '../../../lib/format'
import { prefersReducedMotion } from '../../../lib/motion'
import { setQuery } from '../../../lib/router'
import { NODE_STATUS, toneVar } from '../../../lib/status'
import { clampPan, pct, tickLabel, ticks, zoomAround, type Window } from './scale'
import './time-view.css'

/**
 * 运行页"时间"视图（docs/design/26 §2）：
 * - 每个节点一条泳道，按阶段分组；有 fallback 的 Agent 节点可展开成按调用分组的子行；
 * - 拖拽框选放大，Shift + 滚轮平移，⌘ / Ctrl + 滚轮缩放，双击复位；
 * - 下方上下文曲线与泳道共用时间轴，超过窗口 80% 的部分染琥珀。
 */

type Lane = RunTimeline['lanes'][number]
type Seg = Lane['segments'][number]
type Inv = NonNullable<Lane['invocations']>[number]
type Row =
  | { type: 'stage'; key: string; title: string; index: number; span?: [number, number] }
  | { type: 'lane'; key: string; lane: Lane; depth: number; status: NodeStatus; expandable: boolean; open: boolean }
  | { type: 'inv'; key: string; lane: Lane; inv: Inv; depth: number; n: number }

const ROW = 28
const LABEL_W = 232
const CTX_H = 132
const OVERSCAN = 8

const SEG_LABEL: Record<Seg['kind'], string> = { run: '执行', wait: '等人', queue: '就绪未调度', tool: '工具步骤', compact: '压缩上下文' }

const end = (s: { end?: string }, now: number) => (s.end ? Date.parse(s.end) : now)

function depthOf(lane: Lane, byId: Map<string, Lane>): number {
  let d = 0
  let p = lane.parent
  while (p && d < 4) {
    d++
    p = byId.get(p)?.parent
  }
  return d
}

function buildRows(tl: RunTimeline, detail: RunDetail, open: Set<string>, now: number): Row[] {
  const byId = new Map(tl.lanes.map((l) => [l.nodeId, l]))
  const status = new Map(detail.graph.nodes.map((n) => [n.id, n.status]))
  const stages = detail.workflow.stages
  const groups = new Map<string, Lane[]>()
  for (const l of tl.lanes) {
    const k = l.stage && stages.some((s) => s.id === l.stage) ? l.stage : '__other'
    groups.set(k, [...(groups.get(k) ?? []), l])
  }
  const order = [...stages.map((s) => s.id), '__other'].filter((k) => groups.has(k))
  const rows: Row[] = []
  order.forEach((k, i) => {
    const lanes = groups.get(k)!
    const segs = lanes.flatMap((l) => l.segments.filter((s) => s.kind !== 'tool' && s.kind !== 'compact'))
    const span: [number, number] | undefined = segs.length ? [Math.min(...segs.map((s) => Date.parse(s.start))), Math.max(...segs.map((s) => end(s, now)))] : undefined
    rows.push({ type: 'stage', key: `s:${k}`, title: stages.find((s) => s.id === k)?.title ?? '其他', index: i + 1, span })
    for (const l of lanes) {
      const invs = l.invocations ?? []
      const expandable = invs.length > 1
      const isOpen = expandable && open.has(l.nodeId)
      rows.push({ type: 'lane', key: `l:${l.nodeId}`, lane: l, depth: depthOf(l, byId), status: status.get(l.nodeId) ?? 'pending', expandable, open: isOpen })
      if (isOpen) invs.forEach((inv, n) => rows.push({ type: 'inv', key: `i:${l.nodeId}:${inv.id}`, lane: l, inv, depth: depthOf(l, byId) + 1, n }))
    }
  })
  return rows
}

/** 窗口切换做 260ms 补间；减少动效时直接跳。 */
function useTweenWindow(target: Window): Window {
  const [view, setView] = useState<Window>(target)
  const cur = useRef(view)
  cur.current = view
  useEffect(() => {
    const from = cur.current
    if (from[0] === target[0] && from[1] === target[1]) return
    if (prefersReducedMotion() || document.hidden) return setView(target)
    const t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 260)
      const e = 1 - Math.pow(1 - k, 3)
      setView([from[0] + (target[0] - from[0]) * e, from[1] + (target[1] - from[1]) * e])
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target[0], target[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  return view
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(800)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

interface Hover {
  x: number
  y: number
  lane: Lane
  seg?: Seg
  inv?: Inv
}

export function TimeView({ runId, detail, liveTick, selected, toolbar }: { runId: string; detail: RunDetail; liveTick: number; selected?: string; toolbar: ReactNode }) {
  const q = useAsync((s) => s.timeline(runId), [runId])
  const reload = useRef(q.reload)
  reload.current = q.reload
  useEffect(() => {
    if (liveTick) reload.current()
  }, [liveTick])
  const tl = q.data
  if (q.error && !tl) return <ErrorState error={q.error} onRetry={q.reload} />
  return (
    <div className="tv">
      <div className="tv-bar">
        <TimeLegend />
        <span style={{ flex: 1 }} />
        {toolbar}
      </div>
      {tl ? <TimeBody tl={tl} detail={detail} selected={selected} /> : <div className="tv-skel">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} h={14} w={`${30 + ((i * 37) % 60)}%`} />)}</div>}
    </div>
  )
}

function TimeLegend() {
  return (
    <div className="tv-legend" aria-label="图例">
      <span><i className="lg lg-run" />执行</span>
      <span><i className="lg lg-wait" />等人</span>
      <span><i className="lg lg-queue" />就绪未调度</span>
      <span><i className="lg lg-tool" />工具步骤</span>
      <span><i className="lg lg-long" />长步骤</span>
      <span><i className="lg lg-compact" />压缩</span>
      <span className="tv-hint">拖拽框选放大 · Shift + 滚轮平移 · ⌘ + 滚轮缩放 · 双击复位</span>
    </div>
  )
}

function TimeBody({ tl, detail, selected }: { tl: RunTimeline; detail: RunDetail; selected?: string }) {
  const live = !tl.end && (detail.run.status === 'running' || detail.run.status === 'waiting_human')
  const now = useSecondTick(live)
  const startMs = Date.parse(tl.start)
  const endMs = tl.end ? Date.parse(tl.end) : live ? now : Math.max(startMs + 60_000, ...tl.lanes.flatMap((l) => l.segments.map((s) => end(s, startMs))))
  const pad = (endMs - startMs) * 0.02
  const full: Window = [startMs - pad, endMs + pad * (live ? 1.5 : 1)]
  const [zoom, setZoom] = useState<Window | null>(null)
  const view = useTweenWindow(zoom ?? full)
  const [open, setOpen] = useState<Set<string>>(() => new Set(tl.lanes.filter((l) => l.invocations?.some((v) => v.fallbackIndex)).map((l) => l.nodeId)))
  const rows = useMemo(() => buildRows(tl, detail, open, now), [tl, detail, open, now])
  const [hover, setHover] = useState<Hover | null>(null)
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null)
  const [scroll, setScroll] = useState({ top: 0, h: 600 })
  const body = useRef<HTMLDivElement>(null)
  const [trackRef, trackW] = useWidth<HTMLDivElement>()
  // 首次出现时段落从左打开；之后的刷新不再重播
  const [entering, setEntering] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setEntering(false), 1100)
    return () => clearTimeout(t)
  }, [])

  const tAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    return view[0] + ((clientX - r.left) / r.width) * (view[1] - view[0])
  }

  // 滚轮：Shift / 横向手势平移，⌘ / Ctrl 缩放；普通纵向滚动交给浏览器（上下翻泳道）。React 的 wheel 是 passive，只能原生监听
  const viewRef = useRef({ view, full })
  viewRef.current = { view, full }
  useEffect(() => {
    const el = body.current?.parentElement
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const track = trackRef.current
      if (!track) return
      const { view: v, full: f } = viewRef.current
      const r = track.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const at = v[0] + ((e.clientX - r.left) / r.width) * (v[1] - v[0])
        setZoom(zoomAround(v, at, Math.exp(e.deltaY * 0.0022), f))
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        const d = ((e.deltaX || e.deltaY) / r.width) * (v[1] - v[0])
        setZoom(clampPan([v[0] + d, v[1] + d], f))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [trackRef])

  const onScroll = () => {
    const el = body.current
    if (el) setScroll({ top: el.scrollTop, h: el.clientHeight })
  }
  useLayoutEffect(onScroll, [])

  /** 按下时记住点到的段落：捕获指针之后 pointerup 的 target 会变成容器本身。 */
  const pickAt = (target: EventTarget): { row?: Row; seg?: Seg; inv?: Inv } => {
    const el = (target as HTMLElement).closest<HTMLElement>('[data-row]')
    const row = el ? rows[Number(el.dataset.row)] : undefined
    if (!row || row.type === 'stage') return {}
    const segEl = (target as HTMLElement).closest<HTMLElement>('[data-seg]')
    const segs = row.type === 'inv' ? row.lane.segments.filter((s) => s.invocationId === row.inv.id) : row.lane.segments
    return { row, seg: segEl ? segs[Number(segEl.dataset.seg)] : undefined, inv: row.type === 'inv' ? row.inv : undefined }
  }
  const drag = useRef<{ x0: number; moved: boolean; row?: Row; seg?: Seg } | null>(null)
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !trackRef.current) return
    const r = trackRef.current.getBoundingClientRect()
    if (e.clientX < r.left) return
    drag.current = { x0: e.clientX, moved: false, ...pickAt(e.target) }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d) {
      if (Math.abs(e.clientX - d.x0) > 4) d.moved = true
      if (d.moved) {
        const r = trackRef.current!.getBoundingClientRect()
        setBrush({ a: Math.max(0, Math.min(d.x0, e.clientX) - r.left), b: Math.min(r.width, Math.max(d.x0, e.clientX) - r.left) })
        setHover(null)
      }
      return
    }
    const { row, seg, inv } = pickAt(e.target)
    if (!row || row.type === 'stage') return setHover(null)
    setHover({ x: e.clientX, y: e.clientY, lane: row.lane, seg, inv })
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    setBrush(null)
    if (!d) return
    if (d.moved) {
      const a = tAt(Math.min(d.x0, e.clientX))
      const b = tAt(Math.max(d.x0, e.clientX))
      if (b - a > 1000) setZoom(clampPan([a, b], full))
      return
    }
    // 没拖动：点到段落就打开节点抽屉，并定位到那一步
    const { row, seg } = d
    if (!row || row.type === 'stage' || !seg) return
    setQuery({ node: row.lane.nodeId, dtab: seg.kind === 'tool' || seg.kind === 'compact' ? 'trace' : undefined, at: seg.kind === 'tool' ? (seg.end ?? seg.start) : undefined })
  }

  const first = Math.max(0, Math.floor(scroll.top / ROW) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.h) / ROW) + OVERSCAN)
  const { step, at: tickAt } = ticks(view, trackW)
  const nowPct = live ? pct(now, view) : undefined
  const hovered = hover?.lane.nodeId

  return (
    <div className={`tv-main${entering ? ' is-enter' : ''}`} style={{ '--tv-label': `${LABEL_W}px`, '--tv-row': `${ROW}px` } as CSSProperties} onDoubleClick={() => setZoom(null)}>
      <div className="tv-axis">
        <div className="tv-axis-label">
          {zoom ? (
            <button className="btn btn-xs" onClick={() => setZoom(null)} title="回到整次运行（双击空白处同效）">
              <RotateCcw />
              复位
            </button>
          ) : (
            <span className="faint">整次运行 · {fmtDuration(endMs - startMs)}</span>
          )}
        </div>
        <div className="tv-axis-track" ref={trackRef}>
          {tickAt.map((t) => (
            <span key={t} className="tv-tick mono num" style={{ left: `${pct(t, view)}%` }}>
              {tickLabel(t, step)}
            </span>
          ))}
          {nowPct !== undefined && nowPct >= 0 && nowPct <= 100 && (
            <span className="tv-now-tag" style={{ left: `${nowPct}%` }}>
              现在
            </span>
          )}
        </div>
      </div>
      <div className="tv-body" ref={body} onScroll={onScroll}>
        <div className="tv-rows" style={{ height: rows.length * ROW }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => !drag.current && setHover(null)}>
          <div className="tv-grid" aria-hidden>
            {tickAt.map((t) => (
              <i key={t} style={{ left: `${pct(t, view)}%` }} />
            ))}
            {nowPct !== undefined && nowPct >= 0 && nowPct <= 100 && <b className="tv-now" style={{ left: `${nowPct}%` }} />}
            {brush && <span className="tv-brush" style={{ left: brush.a, width: brush.b - brush.a }} />}
          </div>
          {rows.slice(first, last).map((row, k) => {
            const i = first + k
            return (
              <RowView
                key={row.key}
                row={row}
                i={i}
                view={view}
                now={now}
                hovered={row.type !== 'stage' && row.lane.nodeId === hovered}
                selected={row.type !== 'stage' && row.lane.nodeId === selected}
                onToggle={(id) => setOpen((s) => {
                  const n = new Set(s)
                  if (n.has(id)) n.delete(id)
                  else n.add(id)
                  return n
                })}
              />
            )
          })}
        </div>
      </div>
      <ContextChart tl={tl} view={view} hovered={hovered} width={trackW} />
      {hover && <Tip hover={hover} now={now} />}
    </div>
  )
}

function RowView({ row, i, view, now, hovered, selected, onToggle }: { row: Row; i: number; view: Window; now: number; hovered: boolean; selected: boolean; onToggle: (id: string) => void }) {
  const style = { top: i * ROW, '--row': Math.min(i, 14) } as CSSProperties
  if (row.type === 'stage') {
    return (
      <div className="tv-row tv-stage" style={style} data-row={i}>
        <div className="tv-label">
          <span className="tv-stage-idx mono">{String(row.index).padStart(2, '0')}</span>
          <span className="truncate">{row.title}</span>
        </div>
        <div className="tv-track">{row.span && <span className="tv-stage-span" style={spanStyle(row.span[0], row.span[1], view)} />}</div>
      </div>
    )
  }
  const lane = row.lane
  const meta = NODE_STATUS[row.type === 'lane' ? row.status : 'running']
  const segs = row.type === 'inv' ? lane.segments.filter((s) => s.invocationId === row.inv.id) : lane.segments
  const ordered = segs.map((s, k) => ({ s, k })).sort((a, b) => z(a.s) - z(b.s))
  return (
    <div className={`tv-row tv-lane${row.type === 'inv' ? ' is-inv' : ''}${hovered ? ' is-hover' : ''}${selected ? ' is-selected' : ''}`} style={style} data-row={i}>
      <div className="tv-label" style={{ paddingLeft: 12 + row.depth * 14 }}>
        {row.type === 'lane' ? (
          <>
            {row.expandable ? (
              <button className={`tv-caret${row.open ? ' open' : ''}`} onClick={() => onToggle(lane.nodeId)} aria-expanded={row.open} title={row.open ? '收起调用' : '按调用展开'}>
                <ChevronRight />
              </button>
            ) : (
              <span className="tv-dot" style={{ background: toneVar(meta.tone) }} />
            )}
            <button className="tv-name truncate" onClick={() => setQuery({ node: lane.nodeId, dtab: undefined })} title={`${lane.title}\n${lane.nodeId}`}>
              {lane.title}
            </button>
            {row.expandable && (lane.invocations!.some((v) => v.fallbackIndex) ? <span className="tv-fb" title="这个节点中途换过 harness（fallback）">换 harness</span> : <span className="tv-calls" title="这个节点执行过多次（重试或循环的不同轮次）">×{lane.invocations!.length}</span>)}
          </>
        ) : (
          <span className="tv-inv-label truncate">
            <i style={{ background: harnessHue(row.inv.harness) }} />
            {row.inv.fallbackIndex ? `fallback ${row.inv.fallbackIndex}` : `第 ${row.inv.attempt ?? row.n + 1} 次`} · <span className="mono">{row.inv.harness}</span>
            {row.inv.outcome === 'error' && <b className="tv-inv-err">出错</b>}
          </span>
        )}
      </div>
      <div className="tv-track">
        {row.type === 'inv' && <span className="tv-inv-span" style={{ ...spanStyle(Date.parse(row.inv.start), end(row.inv, now), view), '--inv': harnessHue(row.inv.harness) } as CSSProperties} />}
        {ordered.map(({ s, k }) => {
          const a = Date.parse(s.start)
          const b = end(s, now)
          if (b < view[0] || a > view[1]) return null
          if (s.kind === 'compact') return <span key={k} data-seg={k} className="tv-seg tv-compact" style={{ left: `${pct(a, view)}%` }} />
          return <span key={k} data-seg={k} className={`tv-seg tv-${s.kind}${s.long ? ' is-long' : ''}${s.ok === false ? ' is-fail' : ''}${!s.end ? ' is-live' : ''}${s.kind === 'run' && row.type === 'lane' && row.status === 'failed' ? ' is-failed' : ''}`} style={spanStyle(a, b, view)} />
        })}
        {row.type === 'lane' && !row.open && lane.invocations?.filter((v) => v.fallbackIndex).map((inv) => (
          <span key={inv.id} className="tv-switch" style={{ left: `${pct(Date.parse(inv.start), view)}%` }} title={`换到 ${inv.harness}`}>
            <b>{inv.harness}</b>
          </span>
        ))}
      </div>
    </div>
  )
}

const z = (s: Seg) => (s.kind === 'queue' ? 0 : s.kind === 'run' || s.kind === 'wait' ? 1 : s.kind === 'tool' ? 2 : 3)

/** 段落位置用百分比；最小宽度 2px，免得一闪而过的工具步骤看不见。 */
function spanStyle(a: number, b: number, view: Window): CSSProperties {
  const l = Math.max(-1, pct(a, view))
  const r = Math.min(101, pct(b, view))
  return { left: `${l}%`, width: `max(2px, ${Math.max(0, r - l)}%)` }
}

function Tip({ hover, now }: { hover: Hover; now: number }) {
  const { lane, seg, inv } = hover
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: hover.x + 14, y: hover.y + 16 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({ x: Math.min(window.innerWidth - w - 8, hover.x + 14), y: hover.y + 16 + h > window.innerHeight - 8 ? hover.y - h - 10 : hover.y + 16 })
  }, [hover.x, hover.y])
  let title = lane.title
  let line: ReactNode = null
  let range: [number, number] | undefined
  if (seg) {
    range = [Date.parse(seg.start), end(seg, now)]
    if (seg.kind === 'tool' && seg.tool) {
      const a = toolAction(seg.tool, seg.input ?? '')
      line = (
        <>
          <b>{a.verb}</b> <span className="mono">{a.target}</span>
          {seg.ok === false && <b className="tv-tip-bad"> 失败</b>}
          {seg.long && <b className="tv-tip-long"> 长步骤</b>}
        </>
      )
    } else line = <b>{SEG_LABEL[seg.kind]}</b>
    if (seg.kind === 'wait' && seg.requestId) title += ` · 待办 ${seg.requestId}`
  } else if (inv) {
    range = [Date.parse(inv.start), end(inv, now)]
    line = (
      <>
        <b>调用</b> <span className="mono">{inv.harness}{inv.model ? ` · ${inv.model}` : ''}</span>
        {inv.outcome === 'error' && <b className="tv-tip-bad"> 出错{lane.invocations?.some((v) => (v.fallbackIndex ?? 0) > (inv.fallbackIndex ?? 0)) ? '，已换下一个候选' : ''}</b>}
      </>
    )
  }
  return (
    <div ref={ref} className="tv-tip" style={{ left: pos.x, top: pos.y }} role="tooltip">
      <div className="tv-tip-title truncate">{title}</div>
      {line && <div className="tv-tip-line">{line}</div>}
      {range && (
        <div className="tv-tip-time mono num">
          {fmtTime(new Date(range[0]).toISOString())} → {seg?.end || inv?.end ? fmtTime(new Date(range[1]).toISOString()) : '进行中'} · {fmtDuration(range[1] - range[0])}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 上下文曲线

function ContextChart({ tl, view, hovered, width }: { tl: RunTimeline; view: Window; hovered?: string; width: number }) {
  const lanes = useMemo(() => new Map(tl.lanes.map((l) => [l.nodeId, l])), [tl])
  const [pick, setPick] = useState<{ x: number; y: number; nodeId: string; at: number; tokens: number; window?: number } | null>(null)
  const ctx = tl.context.filter((c) => c.points.length > 1)
  if (!ctx.length) {
    return (
      <div className="tv-ctx is-empty">
        <div className="tv-ctx-label">上下文</div>
        <div className="tv-ctx-empty faint">这次运行没有上下文用量记录</div>
      </div>
    )
  }
  const windows = [...new Set(ctx.map((c) => c.window).filter((w): w is number => w !== undefined))]
  const unknown = ctx.filter((c) => c.window === undefined).length
  const yMax = Math.max(...windows, ...ctx.flatMap((c) => c.points.map((p) => p.tokens))) * 1.08
  const H = CTX_H - 22
  const x = (t: number) => ((t - view[0]) / (view[1] - view[0])) * width
  const y = (v: number) => 6 + (1 - v / yMax) * (H - 6)
  const path = (pts: Array<{ at: string; tokens: number }>) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(Date.parse(p.at)).toFixed(1)} ${y(p.tokens).toFixed(1)}`).join('')
  /** 超过窗口 80% 的折线段（相邻两点有一个超过就算）。 */
  const hot = (c: RunTimeline['context'][number]) => {
    if (!c.window) return ''
    const lim = c.window * 0.8
    let d = ''
    c.points.forEach((p, i) => {
      const q = c.points[i + 1]
      if (!q || (p.tokens < lim && q.tokens < lim)) return
      d += `M${x(Date.parse(p.at)).toFixed(1)} ${y(p.tokens).toFixed(1)}L${x(Date.parse(q.at)).toFixed(1)} ${y(q.tokens).toFixed(1)}`
    })
    return d
  }
  const hueOf = (nodeId: string) => harnessHue(lanes.get(nodeId)?.invocations?.at(-1)?.harness)
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    let best: typeof pick = null
    let bestD = 14
    for (const c of ctx) {
      for (const p of c.points) {
        const d = Math.hypot(x(Date.parse(p.at)) - px, y(p.tokens) - py)
        if (d < bestD) {
          bestD = d
          best = { x: e.clientX, y: e.clientY, nodeId: c.nodeId, at: Date.parse(p.at), tokens: p.tokens, window: c.window }
        }
      }
    }
    setPick(best)
  }
  const focus = pick?.nodeId ?? hovered
  return (
    <div className="tv-ctx">
      <div className="tv-ctx-label">
        <b>上下文</b>
        <span className="faint">每轮输入 token（含缓存）</span>
        <span className="tv-ctx-y mono num" style={{ top: y(yMax / 1.08) }}>{fmtTokens(Math.round(yMax / 1.08))}</span>
        <span className="tv-ctx-y mono num" style={{ top: H }}>0</span>
      </div>
      <div className="tv-ctx-track">
        <svg width={width} height={CTX_H} onPointerMove={onMove} onPointerLeave={() => setPick(null)} role="img" aria-label="上下文窗口曲线">
          {windows.map((w) => (
            <g key={w} className="tv-win">
              <rect x={0} y={y(w)} width={width} height={y(w * 0.8) - y(w)} className="tv-win-band" />
              <line x1={0} x2={width} y1={y(w)} y2={y(w)} className="tv-win-line" />
              <text x={width - 4} y={y(w) - 4} textAnchor="end" className="tv-win-text">
                窗口 {fmtTokens(w)}
              </text>
            </g>
          ))}
          {ctx.map((c) => (
            <g key={c.nodeId} className={`tv-ctx-line${focus && focus !== c.nodeId ? ' is-dim' : ''}${focus === c.nodeId ? ' is-focus' : ''}`} style={{ '--line': hueOf(c.nodeId) } as CSSProperties}>
              <path d={path(c.points)} pathLength={1} className="tv-ctx-path" />
              <path d={hot(c)} className="tv-ctx-hot" />
              {c.compactions.map((m) => {
                const cx = x(Date.parse(m.at))
                return (
                  <g key={m.at} className="tv-ctx-compact">
                    <line x1={cx} x2={cx} y1={y(m.before)} y2={y(m.after)} />
                    <rect x={cx - 3.5} y={y(m.before) - 3.5} width={7} height={7} transform={`rotate(45 ${cx} ${y(m.before)})`} />
                  </g>
                )
              })}
            </g>
          ))}
          {pick && <circle cx={x(pick.at)} cy={y(pick.tokens)} r={3.5} className="tv-ctx-dot" style={{ '--line': hueOf(pick.nodeId) } as CSSProperties} />}
        </svg>
        <div className="tv-ctx-legend faint">
          虚线为窗口上限 · ◆ 压缩点 · 超过窗口 80% 的部分染琥珀
          {unknown > 0 && <> · <b className="tv-ctx-unknown">{unknown} 个节点窗口未知</b>（只画曲线）</>}
        </div>
      </div>
      {pick && (
        <div className="tv-tip" style={{ left: Math.min(window.innerWidth - 240, pick.x + 14), top: pick.y - 64 }} role="tooltip">
          <div className="tv-tip-title truncate">{lanes.get(pick.nodeId)?.title ?? pick.nodeId}</div>
          <div className="tv-tip-line mono num">
            {fmtTokens(pick.tokens)}
            {pick.window ? ` / ${fmtTokens(pick.window)}（${Math.round((pick.tokens / pick.window) * 100)}%）` : ' · 窗口未知'}
          </div>
          <div className="tv-tip-time mono num">{fmtTime(new Date(pick.at).toISOString())}</div>
        </div>
      )}
    </div>
  )
}
