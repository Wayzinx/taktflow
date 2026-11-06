import { useCallback, useEffect, useRef, useState } from 'react'
import type { Actor, LeadPresence, Room, RoomMember, RoomMessage } from '@taktflow/core'
import { useSource } from '../../../api'

/** 消息作者对应的群成员 id：真人用 id，Lead 是 'lead'，子 Agent 用角色名。 */
export function authorId(a: Actor): string {
  if (a.type === 'human') return a.id
  if (a.type === 'agent') return a.role === 'lead' ? 'lead' : a.role
  return a.id
}

export function findMember(members: RoomMember[] | undefined, a: Actor): RoomMember | undefined {
  const id = authorId(a)
  return members?.find((m) => m.id === id)
}

function upsert(list: RoomMessage[], m: RoomMessage): RoomMessage[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i >= 0) return list.map((x, j) => (j === i ? m : x))
  // 按 seq 插入，乱序到达也不会错位
  const next = [...list, m]
  return next.sort((a, b) => a.seq - b.seq)
}

export interface ChatState {
  room?: Room
  messages: RoomMessage[]
  error?: Error
  loading: boolean
  /** 订阅期间实时到达、且来自 Agent 的消息 id：这些消息逐字流出。 */
  live: Set<string>
  /** 每个 taskRunId / requestId 被消息提到的次数，任务卡片、待办卡片据此刷新。 */
  pulse: Record<string, number>
  /** 发出 @lead 后到 Lead 回复前为 true。 */
  leadThinking: boolean
  /** Lead 状态灯：初始值取 Room.lead，之后由群聊 SSE 的 `event: lead` 更新。 */
  lead?: LeadPresence
  send(text: string, mentions: string[], replyTo?: string): Promise<void>
  reload(): void
}

export function useChat(reqId: string): ChatState {
  const ds = useSource()
  const [room, setRoom] = useState<Room>()
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState<Set<string>>(() => new Set())
  const [pulse, setPulse] = useState<Record<string, number>>({})
  const [leadThinking, setLeadThinking] = useState(false)
  const [lead, setLead] = useState<LeadPresence>()
  const [tick, setTick] = useState(0)
  const roomRef = useRef<Room | undefined>(undefined)
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(undefined)
    setMessages([])
    setLive(new Set())
    const bump = (m: RoomMessage) => {
      const keys = [m.refs?.taskRunId, m.refs?.requestId].filter((k): k is string => Boolean(k))
      if (keys.length) setPulse((p) => Object.fromEntries([...Object.entries(p), ...keys.map((k) => [k, (p[k] ?? 0) + 1])]))
    }
    const refreshRoom = () =>
      void ds.room(reqId).then((r) => {
        if (!alive) return
        roomRef.current = r
        setRoom(r)
      })
    Promise.all([ds.room(reqId), ds.chat(reqId)]).then(
      ([r, list]) => {
        if (!alive) return
        roomRef.current = r
        setRoom(r)
        setLead((cur) => cur ?? r.lead)
        setMessages(list)
        setLoading(false)
      },
      (e: Error) => {
        if (!alive) return
        setError(e)
        setLoading(false)
      },
    )
    const off = ds.subscribeChat(reqId, (m) => {
      if (!alive) return
      setMessages((list) => {
        const isNew = !list.some((x) => x.id === m.id)
        if (isNew && m.author.type === 'agent' && (m.kind === 'text' || m.kind === 'progress')) setLive((s) => new Set(s).add(m.id))
        return upsert(list, m)
      })
      bump(m)
      if (m.author.type === 'agent' && m.author.role === 'lead') {
        clearTimeout(thinkTimer.current)
        setLeadThinking(false)
      }
      // 新出现的子 Agent（派发任务时拉进群）：重新拉一次成员
      if (m.author.type !== 'system' && !findMember(roomRef.current?.members, m.author)) refreshRoom()
      if (m.kind === 'task' || m.kind === 'system') refreshRoom()
    }, (p) => alive && setLead(p))
    return () => {
      alive = false
      off()
      clearTimeout(thinkTimer.current)
    }
  }, [ds, reqId, tick])

  const send = useCallback(
    async (text: string, mentions: string[], replyTo?: string) => {
      const m = await ds.postChat(reqId, { text, mentions, replyTo })
      setMessages((list) => upsert(list, m))
      if (mentions.includes('lead')) {
        setLeadThinking(true)
        clearTimeout(thinkTimer.current)
        thinkTimer.current = setTimeout(() => setLeadThinking(false), 20_000)
      }
    },
    [ds, reqId],
  )

  return { room, messages, error, loading, live, pulse, leadThinking, lead, send, reload: () => setTick((t) => t + 1) }
}
