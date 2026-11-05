import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, Sparkles } from 'lucide-react'
import type { RoomMessage } from '@taktflow/core'
import { TaktRuler } from '../../../components/takt'
import { MessageItem, type MessageCtx } from './message-item'

const GROUP_GAP = 5 * 60_000

function sameAuthor(a: RoomMessage, b: RoomMessage): boolean {
  if (a.author.type !== b.author.type) return false
  if (a.author.type === 'agent' && b.author.type === 'agent') return a.author.role === b.author.role
  return (a.author as { id: string }).id === (b.author as { id: string }).id
}

/** 能和上一条合并显示（同作者、5 分钟内、都是普通文本 / 进度）。 */
function grouped(prev: RoomMessage | undefined, m: RoomMessage): boolean {
  if (!prev || prev.kind === 'system' || m.kind !== 'text' || (prev.kind !== 'text' && prev.kind !== 'progress')) return false
  return sameAuthor(prev, m) && Date.parse(m.at) - Date.parse(prev.at) < GROUP_GAP && !m.replyTo
}

/**
 * server 每次任务状态变化都发一条新的 task 消息（同一个 taskRunId）；mock 只发一条。
 * 同一任务只保留一张卡片：留在第一次派发的位置，内容换成最新的一条。
 */
function collapseTasks(messages: RoomMessage[]): Array<{ key: string; m: RoomMessage }> {
  const latest = new Map<string, RoomMessage>()
  for (const m of messages) if (m.kind === 'task' && m.refs?.taskRunId) latest.set(m.refs.taskRunId, m)
  const placed = new Set<string>()
  const out: Array<{ key: string; m: RoomMessage }> = []
  for (const m of messages) {
    const t = m.kind === 'task' ? m.refs?.taskRunId : undefined
    if (!t) {
      out.push({ key: m.id, m })
      continue
    }
    if (placed.has(t)) continue
    placed.add(t)
    out.push({ key: m.id, m: latest.get(t)! })
  }
  return out
}

function dayLabel(ts: string): string {
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return '今天'
  if (d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/**
 * 消息流：贴底时新消息自动滚到底；用户往上翻时不打扰，只显示"N 条新消息"。
 * role=log + aria-live 让读屏播报新消息。
 */
export function MessageFeed({ messages, ctx, leadThinking }: { messages: RoomMessage[]; ctx: MessageCtx; leadThinking: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const seen = useRef(messages.length)
  // 首屏已有的消息不做入场动画，之后到达的才做
  const initial = useRef(new Set(messages.map((m) => m.id)))
  const rows = collapseTasks(messages)
  const [unread, setUnread] = useState(0)

  const toBottom = (smooth: boolean) => {
    const el = box.current
    if (!el) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' })
  }

  useLayoutEffect(() => {
    const added = messages.length - seen.current
    seen.current = messages.length
    if (stick.current) toBottom(added > 0 && added < 5)
    else if (added > 0) setUnread((n) => n + added)
  }, [messages.length])

  // 逐字流出、任务卡片展开时内容会长高；贴底时跟着走
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const inner = el.firstElementChild
    if (!inner) return
    const ro = new ResizeObserver(() => stick.current && toBottom(false))
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  function onScroll() {
    const el = box.current!
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (stick.current) setUnread(0)
  }

  return (
    <div className="chat-feed-wrap">
      <div className="chat-feed" ref={box} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="群聊消息" tabIndex={0}>
        <div className="chat-feed-inner">
          {rows.map(({ key, m }, i) => {
            const prev = rows[i - 1]?.m
            const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString()
            return (
              <div key={key} className={initial.current.has(key) ? 'chat-row' : 'chat-row chat-enter'}>
                {newDay && (
                  <div className="chat-day" role="separator">
                    <span>{dayLabel(m.at)}</span>
                  </div>
                )}
                <MessageItem m={m} grouped={!newDay && grouped(prev, m)} ctx={ctx} />
              </div>
            )
          })}
          {leadThinking && (
            <div className="chat-thinking" role="status">
              <span className="chat-avatar who-lead" aria-hidden="true">
                <Sparkles strokeWidth={2} />
              </span>
              <span>Lead 正在看进度</span>
              <TaktRuler ticks={8} running className="chat-thinking-ruler" />
            </div>
          )}
        </div>
      </div>
      {unread > 0 && (
        <button
          className="btn btn-sm chat-unread"
          onClick={() => {
            stick.current = true
            setUnread(0)
            toBottom(true)
          }}
        >
          <ArrowDown />
          {unread} 条新消息
        </button>
      )}
    </div>
  )
}
