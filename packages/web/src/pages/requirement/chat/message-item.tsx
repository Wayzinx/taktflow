import { Activity, Bot, Cog, CornerUpLeft, Info, Sparkles } from 'lucide-react'
import type { AttentionItem, RoomMember, RoomMessage } from '@taktflow/core'
import { Avatar } from '../../../components/ui'
import { fmtTime } from '../../../lib/format'
import { AttentionMessage } from './attention-message'
import { MessageRefs } from './message-refs'
import { MentionText, StreamingText } from './streaming-text'
import { TaskCard } from './task-card'
import { authorId, findMember } from './use-chat'

export interface MessageCtx {
  members?: RoomMember[]
  byId: Map<string, RoomMessage>
  live: Set<string>
  pulse: Record<string, number>
  attention?: AttentionItem[]
  onReply(m: RoomMessage): void
  /** 任务卡片上报某个任务里正在运行的角色，成员栏据此标"工作中"。 */
  onTaskRoles(runId: string, roles: string[]): void
}

function authorLabel(m: RoomMessage, member?: RoomMember): { name: string; tag?: string; kind: RoomMember['kind'] | 'system' } {
  const a = m.author
  if (a.type === 'system') return { name: a.id === 'engine' ? '引擎' : a.id, kind: 'system' }
  if (a.type === 'agent') return { name: member?.name ?? a.role, tag: a.role === 'lead' ? undefined : a.harness, kind: a.role === 'lead' ? 'lead' : 'agent' }
  return { name: member?.name ?? a.id, tag: member?.role, kind: 'human' }
}

/** 头像：真人用首字母，Lead 和子 Agent 用图标，一眼分清是人还是 AI。 */
export function MemberAvatar({ kind, name }: { kind: RoomMember['kind'] | 'system'; name: string }) {
  if (kind === 'human') return <Avatar name={name} size={28} />
  const Icon = kind === 'lead' ? Sparkles : kind === 'system' ? Cog : Bot
  return (
    <span className={`chat-avatar who-${kind}`} title={name} aria-label={name}>
      <Icon strokeWidth={2} />
    </span>
  )
}

function SystemLine({ m }: { m: RoomMessage }) {
  return (
    <div className="chat-system" role="note">
      <Info aria-hidden="true" />
      <span>{m.text}</span>
      <time className="mono faint" dateTime={m.at}>
        {fmtTime(m.at).slice(0, 5)}
      </time>
      <MessageRefs m={m} />
    </div>
  )
}

/** 一条消息；grouped 时与上一条同作者，省掉头像和名字。 */
export function MessageItem({ m, grouped, ctx }: { m: RoomMessage; grouped: boolean; ctx: MessageCtx }) {
  if (m.kind === 'system') return <SystemLine m={m} />
  const member = findMember(ctx.members, m.author)
  const who = authorLabel(m, member)
  const quoted = m.replyTo ? ctx.byId.get(m.replyTo) : undefined
  const streaming = ctx.live.has(m.id)
  const self = m.author.type === 'human' && m.author.id === 'web'
  const mentionsMe = m.mentions?.includes('web')

  let body
  if (m.kind === 'attention') body = <AttentionMessage m={m} items={ctx.attention} />
  else if (m.kind === 'task') body = <TaskCard m={m} pulse={(m.refs?.taskRunId && ctx.pulse[m.refs.taskRunId]) || 0} onRoles={ctx.onTaskRoles} />
  else
    body = (
      <div className={`chat-text${m.kind === 'progress' ? ' progress' : ''}`}>
        {m.kind === 'progress' && (
          <span className="chat-progress-tag">
            <Activity aria-hidden="true" />
            进度
          </span>
        )}
        <p>{streaming ? <StreamingText text={m.text} members={ctx.members} /> : <MentionText text={m.text} members={ctx.members} />}</p>
      </div>
    )

  return (
    <article className={`chat-msg${grouped ? ' grouped' : ''}${self ? ' self' : ''}${mentionsMe ? ' mentions-me' : ''}`} data-kind={m.kind} aria-label={`${who.name} ${fmtTime(m.at)}`}>
      <div className="chat-msg-gutter">
        {grouped ? (
          <time className="chat-msg-time-hover mono" dateTime={m.at}>
            {fmtTime(m.at).slice(0, 5)}
          </time>
        ) : (
          <MemberAvatar kind={who.kind} name={who.name} />
        )}
      </div>
      <div className="chat-msg-main">
        {!grouped && (
          <header className="chat-msg-head">
            <span className={`chat-msg-name who-${who.kind}`}>{who.name}</span>
            {who.tag && <span className="chat-msg-tag">{who.tag}</span>}
            <time className="chat-msg-time mono" dateTime={m.at} title={m.at}>
              {fmtTime(m.at).slice(0, 5)}
            </time>
          </header>
        )}
        {quoted && (
          <div className="chat-quote">
            <CornerUpLeft aria-hidden="true" />
            <span className="chat-quote-who">{authorId(quoted.author)}</span>
            <span className="truncate">{quoted.text}</span>
          </div>
        )}
        {body}
        <MessageRefs m={m} />
      </div>
      {m.kind !== 'attention' && m.kind !== 'task' && (
        <button className="btn btn-sm btn-ghost btn-icon chat-msg-reply" title="回复" aria-label={`回复 ${who.name}`} onClick={() => ctx.onReply(m)}>
          <CornerUpLeft />
        </button>
      )}
    </article>
  )
}
