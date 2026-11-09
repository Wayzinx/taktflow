import { useState } from 'react'
import { Activity, Cog, CornerUpLeft, Info } from 'lucide-react'
import type { AttentionItem, RoomMember, RoomMessage } from '@taktflow/core'
import { AgentMark, harnessHue } from '../../../components/agent-mark'
import { LeadMark } from '../../../components/identity'
import { RouteCard } from '../../../components/route-card'
import { Avatar } from '../../../components/ui'
import { fmtTime } from '../../../lib/format'
import { AttentionMessage } from './attention-message'
import { hasLeadMarks, LeadText } from './lead-text'
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
  requirementId: string
  onReply(m: RoomMessage): void
  /** 任务卡片上报某个任务里正在运行的角色，成员栏据此标"工作中"。 */
  onTaskRoles(runId: string, roles: string[]): void
  /** 定位到某条消息并高亮（引用、跳转）。 */
  onJump?(messageId: string): void
}

function authorLabel(m: RoomMessage, member?: RoomMember): { name: string; tag?: string; kind: RoomMember['kind'] | 'system' } {
  const a = m.author
  if (a.type === 'system') return { name: a.id === 'engine' ? '引擎' : a.id, kind: 'system' }
  if (a.type === 'agent') return { name: member?.name ?? a.role, tag: a.role === 'lead' ? undefined : a.harness, kind: a.role === 'lead' ? 'lead' : 'agent' }
  return { name: member?.name ?? a.id, tag: member?.role, kind: 'human' }
}

/**
 * 头像（docs/design/30 §1）：真人是首字母头像，Lead 是拿指挥棒的蜂，子 Agent 是按角色拿道具、按 harness 着色的蜂；
 * 引擎这类系统消息用线稿图标。一眼分清是人、是哪个 Agent。
 */
export function MemberAvatar({ kind, name, id, role, harness, size = 24, busy }: { kind: RoomMember['kind'] | 'system'; name: string; id?: string; role?: string; harness?: string; size?: number; busy?: boolean }) {
  if (kind === 'human') return <Avatar name={name} id={id} size={size} />
  if (kind === 'lead') return <LeadMark size={size} harness={harness} label={name} />
  if (kind === 'agent') return <AgentMark state={busy ? 'work' : 'idle'} role={role ?? name} hue={harnessHue(harness)} size={size} label={name} />
  return (
    <span className="chat-avatar who-system" style={{ width: size, height: size }} title={name} aria-label={name}>
      <Cog strokeWidth={2} />
    </span>
  )
}

function SystemLine({ m }: { m: RoomMessage }) {
  return (
    <div className="chat-system" role="note">
      <Info aria-hidden="true" />
      <span className="chat-system-text" title={m.text.length > 120 ? m.text : undefined}>
        {m.text}
      </span>
      <time className="mono faint" dateTime={m.at}>
        {fmtTime(m.at).slice(0, 5)}
      </time>
      <MessageRefs m={m} />
    </div>
  )
}

/** 一条消息；grouped 时与上一条同作者，省掉头像和名字。 */
export function MessageItem({ m, grouped, ctx }: { m: RoomMessage; grouped: boolean; ctx: MessageCtx }) {
  const [streamDone, setStreamDone] = useState(false)
  if (m.kind === 'system') return <SystemLine m={m} />
  const member = findMember(ctx.members, m.author)
  const who = authorLabel(m, member)
  const quoted = m.replyTo ? ctx.byId.get(m.replyTo) : undefined
  const streaming = ctx.live.has(m.id)
  const self = m.author.type === 'human' && m.author.id === 'web'
  const mentionsMe = m.mentions?.includes('web')
  // Lead 的"待确认 / 下一步"标签块：流出期间先按纯文本显示，流完再换成标签块
  const marks = who.kind === 'lead' && (m.kind === 'text' || m.kind === 'progress') && hasLeadMarks(m.text)

  let body
  if (m.kind === 'attention') body = <AttentionMessage m={m} items={ctx.attention} />
  else if (m.kind === 'route' && m.route) body = <RouteCard route={m.route} requirementId={ctx.requirementId} runId={m.refs?.runId} />
  else if (m.kind === 'task')
    body = (
      <TaskCard
        m={m}
        pulse={(m.refs?.taskRunId && ctx.pulse[m.refs.taskRunId]) || 0}
        onRoles={ctx.onTaskRoles}
        requirementId={ctx.requirementId}
        resent={[...ctx.byId.values()].find((x) => x.kind === 'task' && x.replyTo === m.id)?.id}
        onJump={ctx.onJump}
      />
    )
  else
    body = (
      <div className={`chat-text${m.kind === 'progress' ? ' progress' : ''}`}>
        {m.kind === 'progress' && (
          <span className="chat-progress-tag">
            <Activity aria-hidden="true" />
            进度
          </span>
        )}
        {marks && !(streaming && !streamDone) ? (
          <LeadText text={m.text} members={ctx.members} />
        ) : (
          <p>{streaming ? <StreamingText text={marks ? m.text.replace(/\*\*/g, '') : m.text} members={ctx.members} onDone={() => setStreamDone(true)} /> : <MentionText text={m.text} members={ctx.members} />}</p>
        )}
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
          <MemberAvatar kind={who.kind} name={who.name} id={m.author.type === 'agent' ? undefined : m.author.id} role={m.author.type === 'agent' ? m.author.role : undefined} harness={m.author.type === 'agent' ? m.author.harness : undefined} size={28} />
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
          <button type="button" className="chat-quote" title="定位到原消息" onClick={() => ctx.onJump?.(quoted.id)}>
            <CornerUpLeft aria-hidden="true" />
            <span className="chat-quote-who">{authorId(quoted.author)}</span>
            <span className="truncate">{quoted.text.replace(/\*\*/g, '')}</span>
          </button>
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
