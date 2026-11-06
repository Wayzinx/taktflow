import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Pause, Radio } from 'lucide-react'
import type { EventEnvelope } from '@taktflow/core'
import { useSource } from '../api'
import { fmtTime } from '../lib/format'
import { describe, toneColor } from './event-timeline'
import './event-ticker.css'

/** 滚动条只放最近这么多条；更早的去审计日志看。 */
const KEEP = 30
/** 噪声大、单独看没有意义的事件不上滚动条。 */
const QUIET = new Set<EventEnvelope['type']>(['harness.usage', 'context.assembled', 'node.ready'])

/**
 * 运行页底部实时事件滚动条：最近 N 条事件（新的在左），等宽时间戳，悬停暂停（暂停期间新事件攒着、显示条数），
 * 点击带节点的事件定位到该节点。数据自己取（ds.events），liveTick 变化时刷新；live 为 false 时只是静态的最近几条。
 */
export function EventTicker({ runId, live, liveTick, onLocate }: { runId: string; live: boolean; liveTick: number; onLocate(nodeId: string): void }) {
  const ds = useSource()
  const [events, setEvents] = useState<EventEnvelope[]>([])
  const [paused, setPaused] = useState(false)
  const [shown, setShown] = useState<EventEnvelope[]>([])
  // 首次加载的事件不算"新"，只有之后到达的才播入场
  const seen = useRef<number | undefined>(undefined)
  const [freshFrom, setFreshFrom] = useState(Number.POSITIVE_INFINITY)

  useEffect(() => {
    let alive = true
    ds.events(runId)
      .then((all) => {
        if (!alive) return
        const recent = all.filter((e) => !QUIET.has(e.type)).slice(-KEEP).reverse()
        setEvents(recent)
      })
      .catch(() => {
        // 滚动条是辅助信息：取不到就保持上一份，不打断页面
      })
    return () => {
      alive = false
    }
  }, [ds, runId, liveTick])

  useEffect(() => {
    if (paused) return
    const maxSeq = events[0]?.seq
    setFreshFrom(seen.current === undefined ? Number.POSITIVE_INFINITY : seen.current + 1)
    if (maxSeq !== undefined) seen.current = Math.max(seen.current ?? 0, maxSeq)
    setShown(events)
  }, [events, paused])

  const pending = paused ? events.filter((e) => e.seq > (shown[0]?.seq ?? 0)).length : 0

  return (
    <div
      className={`event-ticker${live ? ' is-live' : ''}${paused ? ' is-paused' : ''}`}
      aria-label="实时事件"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setPaused(false)}
    >
      <span className="ticker-label" title={live ? '运行中，新事件实时出现；悬停暂停' : '运行已结束，显示最后的事件'}>
        {paused ? <Pause aria-hidden /> : <Radio aria-hidden />}
        {paused ? '已暂停' : live ? '实时' : '最近事件'}
        {pending > 0 && <b className="mono num">+{pending}</b>}
      </span>
      <ol className="ticker-list" aria-live={live && !paused ? 'polite' : 'off'}>
        {shown.length === 0 && <li className="ticker-empty">还没有事件</li>}
        {shown.map((e) => (
          <TickerItem key={e.seq} e={e} fresh={e.seq >= freshFrom} onLocate={onLocate} />
        ))}
      </ol>
    </div>
  )
}

function TickerItem({ e, fresh, onLocate }: { e: EventEnvelope; fresh: boolean; onLocate(nodeId: string): void }) {
  const info = describe(e)
  const Icon = info.icon
  const body = (
    <>
      <time className="mono num ticker-time" dateTime={e.ts}>
        {fmtTime(e.ts)}
      </time>
      <Icon className="ticker-icon" aria-hidden strokeWidth={2.2} />
      {e.nodeId && <span className="mono ticker-node">{e.nodeId}</span>}
      <span className="ticker-text">{info.title}</span>
    </>
  )
  return (
    <li className={`ticker-item${fresh ? ' fresh' : ''}`} style={{ '--ev-tone': toneColor(info.tone) } as CSSProperties}>
      {e.nodeId ? (
        <button type="button" className="ticker-hit" onClick={() => onLocate(e.nodeId!)} title={`定位到节点 ${e.nodeId} · #${e.seq}`}>
          {body}
        </button>
      ) : (
        <span className="ticker-hit" title={`#${e.seq}`}>
          {body}
        </span>
      )}
    </li>
  )
}
