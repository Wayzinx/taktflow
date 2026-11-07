import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Pause, Radio } from 'lucide-react'
import type { EventEnvelope } from '@taktflow/core'
import { useSource } from '../api'
import { fmtTime } from '../lib/format'
import { describe, toneColor } from './event-timeline'
import { KEEP, mergeRecent } from './event-ticker.merge'
import './event-ticker.css'

/** 噪声大、单独看没有意义的事件不上滚动条。 */
const QUIET = new Set<EventEnvelope['type']>(['harness.usage', 'context.assembled', 'node.ready'])
/** 引擎把机器读的记录（如配方输入 `{"kind":"node.recipe.inputs",…}`）写成 log 行，人看不懂，也不上滚动条。 */
const machineLog = (e: EventEnvelope) => e.type === 'log' && /^\s*\{"kind":"/.test(String((e.data as { message?: unknown }).message ?? ''))
const onTicker = (e: EventEnvelope) => !QUIET.has(e.type) && !machineLog(e)

/**
 * 运行页底部实时事件滚动条：最近 N 条事件（新的在左），等宽时间戳，悬停暂停（暂停期间新事件攒着、显示条数），
 * 点击带节点的事件定位到该节点。数据自己取（ds.events，首次全量、之后按 after 游标增量），liveTick 变化时刷新；live 为 false 时只是静态的最近几条。
 */
export function EventTicker({ runId, live, liveTick, onLocate }: { runId: string; live: boolean; liveTick: number; onLocate(nodeId: string): void }) {
  const ds = useSource()
  const [events, setEvents] = useState<EventEnvelope[]>([])
  const [paused, setPaused] = useState(false)
  const [shown, setShown] = useState<EventEnvelope[]>([])
  // 首次加载的事件不算"新"，只有之后到达的才播入场
  const seen = useRef<number | undefined>(undefined)
  const [freshFrom, setFreshFrom] = useState(Number.POSITIVE_INFINITY)

  // 首次取一次完整日志；之后 liveTick 每变一次只用 after 游标取增量，按 seq 去重合并后保留最近 KEEP 条（长运行不会反复拉几千条）。
  // 请求可能重叠（节拍比请求快），所以不丢弃旧请求的结果，而是统一去重合并；切换运行时清空。
  const cursor = useRef<{ runId: string; seq?: number }>({ runId })
  if (cursor.current.runId !== runId) cursor.current = { runId }
  useEffect(() => {
    const from = cursor.current.seq
    ds.events(runId, from === undefined ? undefined : { after: from })
      .then((batch) => {
        if (cursor.current.runId !== runId) return
        const last = batch[batch.length - 1]?.seq
        cursor.current.seq = Math.max(cursor.current.seq ?? 0, last ?? from ?? 0)
        const fresh = batch.filter(onTicker)
        if (from === undefined) setEvents(fresh.slice(-KEEP).reverse())
        else if (fresh.length) setEvents((prev) => mergeRecent(prev, fresh))
      })
      .catch(() => {
        // 滚动条是辅助信息：取不到就保持上一份，不打断页面
      })
  }, [ds, runId, liveTick])
  useEffect(() => setEvents([]), [runId])

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
        {paused ? <Pause aria-hidden /> : live ? <span className="ticker-live-dot live-ring" aria-hidden /> : <Radio aria-hidden />}
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
      <span className="ticker-text">{e.type === 'harness.message' ? tickerMessage((e.data as { text?: string }).text) : info.title}</span>
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

/** 滚动条只放一行：Agent 消息去掉围栏代码块（完成标准自检的 ```json 等），折叠空白。 */
function tickerMessage(text = ''): string {
  const plain = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/\s+/g, ' ').trim()
  return plain || text.replace(/\s+/g, ' ').trim()
}
