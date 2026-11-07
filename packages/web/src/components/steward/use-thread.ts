import { useCallback, useEffect, useRef, useState } from 'react'
import type { Proposal, StewardContextRef, StewardMessage, StewardPostRequest, StewardStreamEvent, StewardThread } from '@taktflow/core'
import { useSource } from '../../api'

/**
 * 一个管家会话的实时状态：拉详情 + 订阅线程 SSE（message / thinking / tool / delta / proposal / done / error），
 * 发消息时先乐观插入用户消息；没有会话时第一条消息会新建会话（onCreated 回调把 id 交给调用方）。
 * 整页与停靠面板共用。
 */
export interface ThreadState {
  thread?: StewardThread
  messages: StewardMessage[]
  proposals: Record<string, Proposal>
  loading: boolean
  error?: Error
  /** 正在流式输出的管家消息 id。 */
  streamingId?: string
  /** 已发出、管家还没开始回复（等首字）。 */
  waiting: boolean
  /** 首屏就有的消息 id：它们不播入场动画。 */
  initialIds: Set<string>
  send(text: string, opts?: { context?: StewardContextRef[]; attachments?: StewardPostRequest['attachments'] }): Promise<boolean>
  upsertProposal(p: Proposal): void
  patchMessage(id: string, patch: Partial<StewardMessage>): void
  reload(): void
}

const upsert = (list: StewardMessage[], m: StewardMessage) => {
  const i = list.findIndex((x) => x.id === m.id)
  if (i < 0) return [...list, m]
  const next = list.slice()
  const prev = list[i]!
  // 流式中途拉到的详情可能比本地累积的短，保留更长的正文
  next[i] = { ...prev, ...m, text: m.text.length >= prev.text.length ? m.text : prev.text }
  return next
}

export function useStewardThread(threadId: string | undefined, onCreated?: (thread: StewardThread) => void): ThreadState {
  const ds = useSource()
  const [thread, setThread] = useState<StewardThread>()
  const [messages, setMessages] = useState<StewardMessage[]>([])
  const [proposals, setProposals] = useState<Record<string, Proposal>>({})
  const [loading, setLoading] = useState(!!threadId)
  const [error, setError] = useState<Error>()
  const [waiting, setWaiting] = useState(false)
  const [tick, setTick] = useState(0)
  const initialIds = useRef(new Set<string>())
  const created = useRef<string | undefined>(undefined)

  // 详情
  useEffect(() => {
    if (!threadId) {
      setThread(undefined)
      setMessages([])
      setProposals({})
      setLoading(false)
      setError(undefined)
      initialIds.current = new Set()
      return
    }
    let alive = true
    const fresh = created.current === threadId
    if (!fresh) {
      setLoading(true)
      setMessages([])
    }
    setError(undefined)
    ds.stewardThread(threadId).then(
      (d) => {
        if (!alive) return
        if (!fresh) initialIds.current = new Set(d.messages.map((m) => m.id))
        setThread(d.thread)
        setMessages((cur) => d.messages.reduce(upsert, cur.filter((m) => !m.id.startsWith('local-') || !d.messages.some((x) => x.role === 'user' && x.text === m.text))))
        setProposals((cur) => ({ ...Object.fromEntries(d.proposals.map((p) => [p.id, p])), ...cur }))
        setLoading(false)
      },
      (e: Error) => {
        if (!alive) return
        setError(e)
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [ds, threadId, tick])

  // 流
  useEffect(() => {
    if (!threadId) return
    const on = (e: StewardStreamEvent) => {
      switch (e.type) {
        case 'message':
          setWaiting(false)
          setMessages((cur) => upsert(cur, e.message))
          break
        case 'thinking':
          setMessages((cur) => cur.map((m) => (m.id === e.messageId ? { ...m, thinking: e.text } : m)))
          break
        case 'tool':
          setMessages((cur) =>
            cur.map((m) => {
              if (m.id !== e.messageId) return m
              const tools = m.tools ?? []
              const i = tools.findIndex((t) => t.id === e.tool.id)
              return { ...m, tools: i < 0 ? [...tools, e.tool] : tools.map((t, j) => (j === i ? e.tool : t)) }
            }),
          )
          break
        case 'delta':
          setMessages((cur) => cur.map((m) => (m.id === e.messageId ? { ...m, text: m.text + e.text } : m)))
          break
        case 'proposal':
          setProposals((cur) => ({ ...cur, [e.proposal.id]: e.proposal }))
          // 提案先于最终 message 事件到达：挂到正在流式的那条上
          setMessages((cur) => {
            const live = [...cur].reverse().find((m) => m.status === 'streaming')
            if (!live || live.proposalIds?.includes(e.proposal.id)) return cur
            return cur.map((m) => (m.id === live.id ? { ...m, proposalIds: [...(m.proposalIds ?? []), e.proposal.id] } : m))
          })
          break
        case 'done':
          setMessages((cur) => cur.map((m) => (m.id === e.messageId ? { ...m, status: 'done' } : m)))
          break
        case 'error':
          setWaiting(false)
          setMessages((cur) => cur.map((m) => (m.id === e.messageId ? { ...m, status: 'error', error: e.error } : m)))
          break
        default:
          break
      }
    }
    return ds.subscribeSteward(threadId, on)
  }, [ds, threadId])

  const send = useCallback<ThreadState['send']>(
    async (text, opts = {}) => {
      const body: StewardPostRequest = { text, context: opts.context, attachments: opts.attachments }
      const local: StewardMessage = { id: `local-${Date.now()}`, threadId: threadId ?? '', role: 'user', at: new Date().toISOString(), text, context: opts.context }
      setMessages((cur) => [...cur, local])
      setWaiting(true)
      try {
        if (!threadId) {
          const r = await ds.createStewardThread(body)
          created.current = r.thread.id
          setThread(r.thread)
          setMessages((cur) => cur.map((m) => (m.id === local.id ? r.message : m)))
          onCreated?.(r.thread)
        } else {
          const m = await ds.postStewardMessage(threadId, body)
          setMessages((cur) => cur.map((x) => (x.id === local.id ? m : x)))
        }
        return true
      } catch (e) {
        setWaiting(false)
        setMessages((cur) => cur.map((m) => (m.id === local.id ? { ...m, status: 'error', error: (e as Error).message } : m)))
        return false
      }
    },
    [ds, threadId, onCreated],
  )

  const streamingId = messages.find((m) => m.status === 'streaming')?.id
  return {
    thread,
    messages,
    proposals,
    loading,
    error,
    streamingId,
    waiting: waiting && !streamingId,
    initialIds: initialIds.current,
    send,
    upsertProposal: useCallback((p: Proposal) => setProposals((cur) => ({ ...cur, [p.id]: p })), []),
    patchMessage: useCallback((id: string, patch: Partial<StewardMessage>) => setMessages((cur) => cur.map((m) => (m.id === id ? { ...m, ...patch } : m))), []),
    reload: useCallback(() => setTick((t) => t + 1), []),
  }
}
