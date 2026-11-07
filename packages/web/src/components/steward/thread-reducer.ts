import type { StewardMessage, StewardStreamEvent } from '@taktflow/core'

/**
 * 管家会话消息的归并（纯函数，use-thread 用，单测见 test/thread-reducer.test.ts）。
 * 难点是乐观插入的本地消息（id 以 local- 开头）和服务端消息的对齐：
 * 服务端 agent.post 在 HTTP 返回之前就通过线程流 emit 了 { type: 'message', message: user }，
 * 所以"流里先到、POST 后到"和"POST 先到、流里后到"两种顺序都要归并成一条。
 */

export const isLocal = (m: StewardMessage) => m.id.startsWith('local-')

/** 按 key 合并两份列表：新的覆盖旧的同 key 项，旧列表里有、新列表里没有的保留。 */
function mergeBy<T>(prev: T[] | undefined, next: T[] | undefined, key: (x: T) => string): T[] | undefined {
  if (!prev?.length) return next
  if (!next?.length) return prev
  const out = prev.slice()
  for (const x of next) {
    const i = out.findIndex((y) => key(y) === key(x))
    if (i < 0) out.push(x)
    else out[i] = x
  }
  return out
}

export function upsert(list: StewardMessage[], m: StewardMessage): StewardMessage[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i < 0) return [...list, m]
  const prev = list[i]!
  // 详情是在流式中途拉到的（还是 streaming、工具和提案为空），而流已经把这条推到了 done：旧快照不能覆盖新状态
  if (m.status === 'streaming' && prev.status && prev.status !== 'streaming') return list
  const next = list.slice()
  next[i] = {
    ...prev,
    ...m,
    // 流式中途拉到的详情可能比本地累积的短，保留更长的正文；工具卡、提案、转达按 id 合并，不被较旧的空列表冲掉
    text: m.text.length >= prev.text.length ? m.text : prev.text,
    tools: mergeBy(prev.tools, m.tools, (t) => t.id),
    proposalIds: mergeBy(prev.proposalIds, m.proposalIds, (id) => id),
    delegations: mergeBy(prev.delegations, m.delegations, (d) => d.messageId),
    citations: m.citations?.length ? m.citations : prev.citations,
  }
  return next
}

/** 服务端的用户消息到了：吞掉文本相同的第一条本地乐观消息（原位替换，保持顺序）。 */
function absorbLocal(list: StewardMessage[], m: StewardMessage): StewardMessage[] {
  if (m.role !== 'user' || list.some((x) => x.id === m.id)) return upsert(list, m)
  const i = list.findIndex((x) => isLocal(x) && x.text === m.text && x.status !== 'error')
  if (i < 0) return upsert(list, m)
  const next = list.slice()
  next[i] = m
  return next
}

/** POST 返回了服务端消息 m：流里已经有这条时删掉本地那条，否则把本地那条换成 m。 */
export function settleLocal(list: StewardMessage[], localId: string, m: StewardMessage): StewardMessage[] {
  if (!list.some((x) => x.id === localId)) return upsert(list, m)
  if (list.some((x) => x.id === m.id)) return upsert(list.filter((x) => x.id !== localId), m)
  return list.map((x) => (x.id === localId ? m : x))
}

/** 详情拉回来时：已被服务端消息覆盖的本地消息去掉，其余按 id 归并。 */
export function mergeDetail(cur: StewardMessage[], fresh: StewardMessage[]): StewardMessage[] {
  const kept = cur.filter((m) => !isLocal(m) || !fresh.some((x) => x.role === 'user' && x.text === m.text))
  return fresh.reduce(upsert, kept)
}

/** 线程流事件 → 新消息列表（proposal 事件只负责把提案挂到正在流式的那条上，提案本体由调用方存）。 */
export function applyStreamEvent(cur: StewardMessage[], e: StewardStreamEvent): StewardMessage[] {
  const patch = (id: string, f: (m: StewardMessage) => StewardMessage) => cur.map((m) => (m.id === id ? f(m) : m))
  switch (e.type) {
    case 'message':
      return absorbLocal(cur, e.message)
    case 'thinking':
      return patch(e.messageId, (m) => ({ ...m, thinking: e.text }))
    case 'tool':
      return patch(e.messageId, (m) => {
        const tools = m.tools ?? []
        const i = tools.findIndex((t) => t.id === e.tool.id)
        return { ...m, tools: i < 0 ? [...tools, e.tool] : tools.map((t, j) => (j === i ? e.tool : t)) }
      })
    case 'delta':
      return patch(e.messageId, (m) => ({ ...m, text: m.text + e.text }))
    case 'proposal': {
      const live = [...cur].reverse().find((m) => m.status === 'streaming')
      if (!live || live.proposalIds?.includes(e.proposal.id)) return cur
      return patch(live.id, (m) => ({ ...m, proposalIds: [...(m.proposalIds ?? []), e.proposal.id] }))
    }
    case 'delegation':
      // 转达给 Lead 的结果回到同一张卡片上（设计 22 §1.1）：按群聊消息 id upsert
      return patch(e.messageId, (m) => {
        const list = m.delegations ?? []
        const i = list.findIndex((d) => d.messageId === e.delegation.messageId)
        return { ...m, delegations: i < 0 ? [...list, e.delegation] : list.map((d, j) => (j === i ? e.delegation : d)) }
      })
    case 'done':
      return patch(e.messageId, (m) => ({ ...m, status: 'done' }))
    case 'error':
      return patch(e.messageId, (m) => ({ ...m, status: 'error', error: e.error }))
    default:
      return cur
  }
}
