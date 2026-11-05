import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RequirementDetail, RoomMessage } from '@taktflow/core'
import { MessagesSquare } from 'lucide-react'
import { useAsync } from '../../api'
import { EmptyState, ErrorState } from '../../components/ui'
import { TaktLoader } from '../../components/takt'
import { Composer, type ComposerApi } from './chat/composer'
import { MemberList } from './chat/member-list'
import { MessageFeed } from './chat/message-feed'
import type { MessageCtx } from './chat/message-item'
import { useChat } from './chat/use-chat'
import './chat/chat.css'
import './chat/chat-messages.css'
import './chat/chat-task.css'

/** 需求页 · 群聊：成员栏 + 消息流（实时到达、Lead 逐字流出）+ 输入框（@ 成员 / @lead）。 */
export function ChatTab({ id, detail }: { id: string; detail?: RequirementDetail }) {
  const chat = useChat(id)
  const attention = useAsync((ds) => ds.attention(), [id])
  const [replyTo, setReplyTo] = useState<RoomMessage>()
  const [taskRoles, setTaskRoles] = useState<Record<string, string[]>>({})
  const composer = useRef<ComposerApi>(null)

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
  const ctx: MessageCtx = {
    members: chat.room?.members,
    byId,
    live: chat.live,
    pulse: chat.pulse,
    attention: attention.data?.filter((a) => a.requirementId === id),
    onReply: (m) => {
      setReplyTo(m)
      composer.current?.focus()
    },
    onTaskRoles,
  }

  if (chat.error && !chat.room) return <ErrorState error={chat.error} onRetry={chat.reload} />
  if (chat.loading || !chat.room) {
    return (
      <div className="card chat-loading">
        <TaktLoader label="正在读取群成员与消息" />
      </div>
    )
  }
  const room = chat.room
  return (
    <div className="chat-layout">
      <MemberList members={room.members} busy={busy} onMention={(mid) => composer.current?.mention(mid)} />
      <section className="card chat-main" aria-label={`${detail?.title ?? id} 需求群`}>
        <header className="card-head chat-head">
          <MessagesSquare aria-hidden="true" />
          <h3 className="card-title truncate">{room.title}</h3>
          <span className="spacer" />
          {room.external && <span className="chip mono">已绑定 {room.external.kind}</span>}
          <span className="faint chat-head-count">{room.members.length} 位成员</span>
        </header>
        {chat.messages.length === 0 ? (
          <div className="chat-feed-wrap">
            <EmptyState icon={MessagesSquare} title="群里还没有消息" hint="@lead 问进度、提要求，Lead 会派任务并把结果回帖到这里。" />
          </div>
        ) : (
          <MessageFeed messages={chat.messages} ctx={ctx} leadThinking={chat.leadThinking} />
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
