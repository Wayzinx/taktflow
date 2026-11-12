import { useCallback, useEffect, useRef, useState } from 'react'
import type { Proposal, StewardContextRef, StewardMessage, StewardPostRequest, StewardRuntime, StewardStreamEvent, StewardThread } from '@taktflow/core'
import { invalidate, useSource } from '../../api'
import { applyStreamEvent, mergeDetail, settleLocal } from './thread-reducer'
import { onTabReturn } from '../../lib/visible'

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
  /** runtime 只在新建会话时带上（第一条回复就用它）；已有会话用 setRuntime。 */
  send(text: string, opts?: { context?: StewardContextRef[]; attachments?: StewardPostRequest['attachments']; runtime?: StewardRuntime }): Promise<boolean>
  /** 已有会话换 harness × 模型（null 回到默认）；失败抛错，调用方提示。 */
  setRuntime(runtime: StewardRuntime | null): Promise<void>
  /** 停下正在写的回复；服务端说没有在写（页面状态落后了）就补拉一次详情。 */
  stop(): Promise<void>
  upsertProposal(p: Proposal): void
  patchMessage(id: string, patch: Partial<StewardMessage>): void
  reload(): void
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
        setMessages((cur) => mergeDetail(cur, d.messages))
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
      if ((e.type === 'message' && e.message.role !== 'user') || e.type === 'error') setWaiting(false)
      if (e.type === 'proposal') setProposals((cur) => ({ ...cur, [e.proposal.id]: e.proposal }))
      // 低风险自动执行的提案没经过卡片上的批准按钮：同样让页面重新取数
      if (e.type === 'proposal' && e.proposal.auto && e.proposal.status === 'applied') invalidate()
      setMessages((cur) => applyStreamEvent(cur, e))
    }
    return ds.subscribeSteward(threadId, on)
  }, [ds, threadId])

  // 后台标签页的流断开过（lib/visible），回来静默补拉一次：回复可能已经写完
  useEffect(() => {
    if (!threadId) return
    return onTabReturn(() => {
      ds.stewardThread(threadId).then(
        (d) => {
          setMessages((cur) => mergeDetail(cur, d.messages))
          setProposals((cur) => ({ ...cur, ...Object.fromEntries(d.proposals.map((p) => [p.id, p])) }))
          if (d.messages.at(-1)?.role !== 'user') setWaiting(false)
        },
        () => undefined,
      )
    })
  }, [ds, threadId])

  // 消息引用了还没拿到的提案（新会话的流在提案事件之后才连上，proposal 事件就错过了）：补拉一次详情
  const missing = [...new Set(messages.flatMap((m) => m.proposalIds ?? []))].filter((id) => !proposals[id]).sort().join(',')
  const fetchedFor = useRef('')
  useEffect(() => {
    if (!threadId || !missing || fetchedFor.current === missing) return
    fetchedFor.current = missing
    let alive = true
    const t = setTimeout(() => {
      ds.stewardThread(threadId).then(
        (d) => alive && setProposals((cur) => ({ ...Object.fromEntries(d.proposals.map((p) => [p.id, p])), ...cur })),
        () => undefined,
      )
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [ds, threadId, missing])

  const send = useCallback<ThreadState['send']>(
    async (text, opts = {}) => {
      const body: StewardPostRequest = { text, context: opts.context, attachments: opts.attachments, ...(!threadId && opts.runtime ? { runtime: opts.runtime } : {}) }
      const local: StewardMessage = { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, threadId: threadId ?? '', role: 'user', at: new Date().toISOString(), text, context: opts.context }
      setMessages((cur) => [...cur, local])
      setWaiting(true)
      try {
        if (!threadId) {
          const r = await ds.createStewardThread(body)
          created.current = r.thread.id
          setThread(r.thread)
          setMessages((cur) => settleLocal(cur, local.id, r.message))
          onCreated?.(r.thread)
        } else {
          const m = await ds.postStewardMessage(threadId, body)
          setMessages((cur) => settleLocal(cur, local.id, m))
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
    setRuntime: useCallback(
      async (runtime: StewardRuntime | null) => {
        if (!threadId) return
        setThread(await ds.patchStewardThread(threadId, { runtime }))
      },
      [ds, threadId],
    ),
    stop: useCallback(async () => {
      if (!threadId) return
      if (!(await ds.stopStewardThread(threadId)).stopped) setTick((t) => t + 1)
    }, [ds, threadId]),
    upsertProposal: useCallback((p: Proposal) => setProposals((cur) => ({ ...cur, [p.id]: p })), []),
    patchMessage: useCallback((id: string, patch: Partial<StewardMessage>) => setMessages((cur) => cur.map((m) => (m.id === id ? { ...m, ...patch } : m))), []),
    reload: useCallback(() => setTick((t) => t + 1), []),
  }
}
