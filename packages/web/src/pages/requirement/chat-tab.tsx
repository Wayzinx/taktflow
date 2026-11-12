import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RequirementDetail, RoomMessage } from '@taktflow/core'
import { MessagesSquare, RotateCw, Settings2, TriangleAlert } from 'lucide-react'
import { useAsync } from '../../api'
import { EmptyState, ErrorState, SkeletonRows, toast } from '../../components/ui'
import { LeadLight } from '../../components/lead-light'
import { Link, setQuery, useLocation } from '../../lib/router'
import { Composer, type ComposerApi } from './chat/composer'
import { leadTurnFailure, leadUsesMock } from './chat/lead-receipts'
import { MemberList } from './chat/member-list'
import { MessageFeed, type FeedApi } from './chat/message-feed'
import type { MessageCtx } from './chat/message-item'
import { useChat } from './chat/use-chat'
import './chat/chat.css'
import './chat/chat-messages.css'
import './chat/chat-task.css'
import './chat/chat-lead.css'

/**
 * 从 URL 找要定位的消息：`msg=<消息 id>`；`artifact=<路径>`（可带 `v=<版本>`）或 `node=<节点 id>`
 * 取最近一条引用它的消息。
 */
function jumpTarget(messages: RoomMessage[], q: URLSearchParams): string | undefined {
  const msg = q.get('msg')
  if (msg) return msg
  const art = q.get('artifact')
  const v = q.get('v')
  const node = q.get('node')
  if (!art && !node) return undefined
  const hit = [...messages].reverse().find((m) => {
    if (art) return m.refs?.artifacts?.some((a) => a.path === art && (!v || String(a.version) === v))
    return m.refs?.nodeId === node
  })
  return hit?.id
}

/**
 * 需求页 · 群聊：成员栏 + 消息流（实时到达、Lead 逐字流出）+ 输入框（@ 成员 / @lead）。
 * URL：`?tab=chat&compose=<文本>` 预填输入框；`msg` / `artifact` / `node` 定位并高亮消息（见 jumpTarget）。
 */
export function ChatTab({ id, detail }: { id: string; detail?: RequirementDetail }) {
  const chat = useChat(id)
  const attention = useAsync((ds) => ds.attention(), [id])
  const [replyTo, setReplyTo] = useState<RoomMessage>()
  const [taskRoles, setTaskRoles] = useState<Record<string, string[]>>({})
  const [retried, setRetried] = useState<string>()
  const composer = useRef<ComposerApi>(null)
  const feed = useRef<FeedApi>(null)
  const { query } = useLocation()
  const compose = query.get('compose')
  const jumpKey = ['msg', 'artifact', 'v', 'node'].map((k) => query.get(k) ?? '').join('|')
  const ready = Boolean(chat.room) && !chat.loading

  // ?compose= 预填一次后从 URL 摘掉，刷新不会重复覆盖草稿
  useEffect(() => {
    if (!ready || compose === null) return
    composer.current?.prefill(compose)
    setQuery({ compose: undefined })
  }, [ready, compose])

  // 引用跳转：消息到齐后定位；找到就摘掉参数（找不到先保留，等实时消息）
  useEffect(() => {
    if (!ready || jumpKey === '|||') return
    const id = jumpTarget(chat.messages, query)
    if (!id) return
    const t = requestAnimationFrame(() => {
      if (feed.current?.jumpTo(id)) setQuery({ msg: undefined, artifact: undefined, v: undefined, node: undefined })
    })
    return () => cancelAnimationFrame(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, jumpKey, chat.messages.length])

  // 群里出现新的待办或待办状态变化时，重新拉待办列表（保留旧数据，不闪）
  const attnPulse = Object.entries(chat.pulse)
    .filter(([k]) => chat.messages.some((m) => m.refs?.requestId === k))
    .reduce((s, [, n]) => s + n, 0)
  const reloadAttention = attention.reload
  useEffect(() => {
    if (attnPulse) reloadAttention()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attnPulse])

  const onTaskRoles = useCallback((runId: string, roles: string[]) => setTaskRoles((s) => (s[runId]?.join() === roles.join() ? s : { ...s, [runId]: roles })), [])
  const busy = useMemo(() => {
    const s = new Set(Object.values(taskRoles).flat())
    if (chat.leadThinking) s.add('lead')
    return s
  }, [taskRoles, chat.leadThinking])

  const byId = useMemo(() => new Map(chat.messages.map((m) => [m.id, m])), [chat.messages])
  // 最近一回合失败：Lead 状态显示"失败"，并给重试 / 去设置两个入口；重试后先收起旧提示
  const failure = leadTurnFailure(chat.messages, chat.lead)
  const showFailure = failure && failure.messageId !== retried ? failure : undefined
  const demo = leadUsesMock(chat.messages)
  const retryLead = async () => {
    if (!showFailure?.trigger || !showFailure.retryable) return
    setRetried(showFailure.messageId)
    try {
      await chat.send(showFailure.trigger.text, [...new Set([...(showFailure.trigger.mentions ?? []), 'lead'])], showFailure.trigger.replyTo)
    } catch (e) {
      setRetried(undefined)
      toast('没能重试', { tone: 'failed', body: (e as Error).message })
    }
  }
  const ctx: MessageCtx = {
    members: chat.room?.members,
    byId,
    live: chat.live,
    pulse: chat.pulse,
    attention: attention.data?.filter((a) => a.requirementId === id),
    requirementId: id,
    onReply: (m) => {
      setReplyTo(m)
      composer.current?.focus()
    },
    onTaskRoles,
    onJump: (mid) => feed.current?.jumpTo(mid),
  }

  if (chat.error && !chat.room) return <ErrorState error={chat.error} onRetry={chat.reload} />
  if (chat.loading || !chat.room) {
    return (
      <div className="card chat-loading" aria-busy="true" style={{ padding: 20 }}>
        <SkeletonRows rows={6} gap={20} />
      </div>
    )
  }
  const room = chat.room
  return (
    <div className="chat-layout">
      <MemberList members={room.members} busy={busy} lead={chat.lead} leadFailed={showFailure?.reason} demo={demo} onMention={(mid) => composer.current?.mention(mid)} />
      <section className="card chat-main" aria-label={`${detail?.title ?? id} 需求群`}>
        <header className="card-head chat-head">
          <MessagesSquare aria-hidden="true" />
          <h3 className="card-title truncate">{room.title}</h3>
          <span className="spacer" />
          <LeadLight presence={chat.lead} showLabel failed={showFailure?.reason} />
          {room.external && <span className="chip mono">已绑定 {room.external.kind}</span>}
          <span className="faint chat-head-count">{room.members.length} 位成员</span>
        </header>
        {showFailure && (
          <div className="chat-lead-failure" role="alert">
            <TriangleAlert aria-hidden />
            <span className="chat-lead-failure-text">
              <b>Lead 上一回合失败</b>
              <span title={showFailure.reason}>{showFailure.reason}</span>
            </span>
            <Link to="/settings?tab=runtime" className="btn btn-sm">
              <Settings2 aria-hidden />
              检查模型与 Harness 设置
            </Link>
            <button type="button" className="btn btn-sm btn-primary" disabled={!showFailure.retryable || chat.leadThinking} title={showFailure.retryable ? '原样重发触发这一回合的消息' : '找不到触发这一回合的消息，请在输入框重新 @lead'} onClick={() => void retryLead()}>
              <RotateCw aria-hidden />
              重试
            </button>
          </div>
        )}
        {chat.messages.length === 0 ? (
          <div className="chat-feed-wrap">
            <EmptyState icon={MessagesSquare} title="群里还没有消息" body="@lead 问进度、提要求，Lead 会派任务并把结果回帖到这里。" />
          </div>
        ) : (
          <MessageFeed apiRef={feed} messages={chat.messages} ctx={ctx} leadThinking={chat.leadThinking} />
        )}
        <Composer
          apiRef={composer}
          members={room.members}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(undefined)}
          onSend={async (text, mentions) => {
            await chat.send(text, mentions, replyTo?.id)
            setReplyTo(undefined)
          }}
        />
      </section>
    </div>
  )
}
