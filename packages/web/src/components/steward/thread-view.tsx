import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bee } from '../mascot'
import type { StewardContextRef, StewardRuntime, StewardThread } from '@taktflow/core'
import { ErrorState, Skeleton, SkeletonText, toast } from '../ui'
import { Composer } from './composer'
import { RuntimePicker } from './runtime-picker'
import { MessageView } from './message'
import { useStewardThread } from './use-thread'
import './steward.css'

export interface ThreadViewProps {
  threadId?: string
  onThreadCreated: (t: StewardThread) => void
  draft: string
  onDraft: (v: string) => void
  context: StewardContextRef[]
  onContext: (next: StewardContextRef[]) => void
  /** 没有会话时显示（欢迎 / 今日汇报）；函数形式拿到 ask(text)：直接发出一条消息。 */
  empty?: ReactNode | ((ask: (text: string, ctx?: StewardContextRef[]) => void) => ReactNode)
  autoFocus?: boolean
  className?: string
  /** 没有会话时输入框居中（Solo 首页）：hero 在输入框上方，empty 在下方。 */
  hero?: ReactNode
  /** @ 引用跨全部空间找（Solo）。 */
  globalMentions?: boolean
  placeholder?: string
}

function ThreadSkeleton() {
  return (
    <div className="stw-thread-sk" role="status" aria-label="正在读取会话">
      <Skeleton w="46%" h={34} r={10} style={{ marginLeft: 'auto' }} />
      <div style={{ display: 'flex', gap: 12 }}>
        <Skeleton w={28} h={28} r={8} />
        <div style={{ flex: 1, display: 'grid', gap: 10 }}>
          <Skeleton w="72%" h={30} r={6} />
          <SkeletonText lines={3} />
        </div>
      </div>
      <Skeleton w="38%" h={34} r={10} style={{ marginLeft: 'auto' }} />
    </div>
  )
}

/** 会话：消息列表（贴底自动滚动，用户往上翻时不打扰）+ 输入框。整页与停靠面板共用。 */
export function ThreadView({ threadId, onThreadCreated, draft, onDraft, context, onContext, empty, autoFocus, className, hero, globalMentions, placeholder }: ThreadViewProps) {
  const t = useStewardThread(threadId, onThreadCreated)
  // 新会话还没有 id：选的 runtime 先记在这里，第一条消息带上（docs/design/30 §2）
  const [draftRuntime, setDraftRuntime] = useState<StewardRuntime>()
  const runtime = threadId ? t.thread?.runtime : draftRuntime
  const changeRuntime = (next: StewardRuntime | null) => {
    if (!threadId) return setDraftRuntime(next ?? undefined)
    t.setRuntime(next).catch((e: Error) => toast('没换成', { tone: 'failed', body: e.message }))
  }
  const list = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lastSteward = [...t.messages].reverse().find((m) => m.role === 'steward')?.id

  const landed = useRef<string>(undefined)
  useEffect(() => {
    stick.current = true
  }, [threadId])
  // 首屏：有待你决定的提案就停在它那里（并高亮），否则到底；之后只有贴底时才跟随
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    if (threadId && !t.loading && t.messages.length && landed.current !== threadId) {
      landed.current = threadId
      const pending = Object.values(t.proposals).find((p) => p.status === 'pending' && t.messages.some((m) => m.proposalIds?.includes(p.id)))
      const target = pending && el.querySelector<HTMLElement>(`[data-steward-anchor="${CSS.escape(pending.id)}"]`)
      if (target) {
        el.scrollTop = target.offsetTop - 16
        stick.current = false
        target.classList.add('jump-highlight')
        setTimeout(() => target.classList.remove('jump-highlight'), 2500)
        return
      }
    }
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [threadId, t.messages, t.proposals, t.loading, t.waiting])

  const send = (text: string, extra: { context: StewardContextRef[]; attachments: Array<{ name: string; content: string }> }) => {
    stick.current = true
    return t.send(text, { context: extra.context.length ? extra.context : undefined, attachments: extra.attachments.length ? extra.attachments : undefined, runtime: draftRuntime })
  }
  const showEmpty = !threadId && t.messages.length === 0
  const busy = !!t.streamingId || t.waiting
  const stop = () => void t.stop().catch((e: Error) => toast('没停下来', { tone: 'failed', body: e.message }))
  // 最后一条回复失败或被停下：重发它前面那条提问（带原来的上下文）。前面是批准后的系统消息时不重发更早的提问，免得把已执行的提案再提一遍
  const last = t.messages.at(-1)
  const asked = last?.role === 'steward' && (last.status === 'error' || last.status === 'stopped') ? [...t.messages].reverse().find((m) => m.role !== 'steward') : undefined
  const retry = asked?.role === 'user' && !busy ? () => void send(asked.text, { context: asked.context ?? [], attachments: [] }) : undefined
  const composer = <Composer draft={draft} onDraft={onDraft} context={context} onContext={onContext} onSend={send} busy={busy} onStop={threadId && busy ? stop : undefined} autoFocus={autoFocus} globalMentions={globalMentions} placeholder={placeholder} tools={<RuntimePicker value={runtime} onChange={changeRuntime} />} />
  const emptyBody = typeof empty === 'function' ? empty((text, c) => void send(text, { context: c ?? context, attachments: [] })) : empty

  if (showEmpty && hero !== undefined)
    return (
      <div className={`stw-thread stw-thread-hero${className ? ` ${className}` : ''}`}>
        <div className="stw-hero">
          {hero}
          {composer}
          {emptyBody}
        </div>
      </div>
    )

  return (
    <div className={`stw-thread${className ? ` ${className}` : ''}`}>
      <div
        ref={list}
        className="stw-thread-list"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {t.error && !t.messages.length ? (
          <ErrorState error={t.error} onRetry={t.reload} compact />
        ) : t.loading && !t.messages.length ? (
          <ThreadSkeleton />
        ) : showEmpty ? (
          emptyBody
        ) : (
          <div className="stw-msgs">
            {t.messages.map((m) => (
              <MessageView
                key={m.id}
                m={m}
                proposals={t.proposals}
                animate={!t.initialIds.has(m.id)}
                showSuggestions={m.id === lastSteward}
                onProposal={t.upsertProposal}
                onPatch={(patch) => t.patchMessage(m.id, patch)}
                onSuggest={(s, c) => void send(s, { context: c ?? context, attachments: [] })}
                onRetry={m.id === last?.id ? retry : undefined}
              />
            ))}
            {t.waiting && (
              <div className="stw-msg stw-msg-steward stw-in" aria-label="管家正在回复">
                <Bee className="stw-avatar" state="think" size={30} />
                <div className="stw-msg-main">
                  <div className="stw-thinking">
                    <span className="shimmer-text">正在读你的问题</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="stw-thread-foot">{composer}</div>
    </div>
  )
}
