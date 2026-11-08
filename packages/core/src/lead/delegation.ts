import type { ProjectStores } from '../interfaces.js'
import type { RoomMessage, RunState } from '../types.js'

export class TaskResendConflictError extends Error {}

export function assertTaskResendable(messages: RoomMessage[], original: RoomMessage): void {
  const tasks = messages.filter(message => message.kind === 'task')
  const ids = new Set([original.id])
  const runIds = new Set<string>()
  if (original.refs?.taskRunId) runIds.add(original.refs.taskRunId)
  // 旧回执与派发消息可能同为触发消息的回复，先按运行归组，再沿任务 replyTo 链连接重发。
  let changed = true
  while (changed) {
    changed = false
    for (const message of tasks) {
      if (!ids.has(message.id) && !(message.replyTo && ids.has(message.replyTo)) && !(message.refs?.taskRunId && runIds.has(message.refs.taskRunId))) continue
      const parent = tasks.find(parent => parent.id === message.replyTo)
      for (const related of [message, ...(parent ? [parent] : [])]) {
        if (!ids.has(related.id)) { ids.add(related.id); changed = true }
        if (related.refs?.taskRunId && !runIds.has(related.refs.taskRunId)) { runIds.add(related.refs.taskRunId); changed = true }
      }
    }
  }
  const latest = tasks.filter(message => ids.has(message.id) && message.receipt).sort((a, b) => a.seq - b.seq).at(-1) ?? original
  const attemptIds = new Set(tasks.filter(message => message.id === original.id || original.refs?.taskRunId && message.refs?.taskRunId === original.refs.taskRunId).map(message => message.id))
  const resent = tasks.some(message => message.replyTo && attemptIds.has(message.replyTo)
    && (message.refs?.taskRunId !== original.refs?.taskRunId || message.receipt?.status === 'sent'))
  if (original.kind !== 'task' || !['uncertain', 'expired'].includes(latest.receipt?.status ?? '') || resent) {
    throw new TaskResendConflictError('只允许重发不确定或过期的任务，且同一任务不能重复重发；请刷新群聊并查看最新回执')
  }
}

export async function delegationOrigin(stores: ProjectStores, message: RoomMessage): Promise<Pick<NonNullable<RunState['origin']>, 'hops' | 'chain'>> {
  if (message.author.type === 'human') return { hops: 0, chain: [] }
  const sourceId = message.refs?.taskRunId ?? message.refs?.runId
  if (!sourceId) return { hops: 0, chain: [] }
  const source = await stores.runs.get(sourceId)
  if (!source || source.requirementId !== message.roomId) throw new Error('上游运行不存在或不属于当前需求，请核对转达来源')
  return { hops: (source.origin?.hops ?? 0) + 1, chain: [...(source.origin?.chain ?? []), sourceId] }
}
export async function checkDelegationHops(stores: ProjectStores, message: RoomMessage): Promise<void> {
  const origin = await delegationOrigin(stores, message)
  const max = stores.config.lead?.maxHops ?? 10
  if (origin.hops! <= max) return
  const note = `派发被拒绝：链路超过 ${max} 跳（${origin.hops}），上游：${origin.chain!.join(' → ')}。请由负责人检查后重新发起。`
  await stores.chat.post(message.roomId, { author: { type: 'system', id: 'lead' }, kind: 'task', text: note, replyTo: message.id, receipt: { status: 'refused', ...origin, note } })
  await stores.chat.post(message.roomId, { author: { type: 'system', id: 'lead' }, kind: 'system', text: note, replyTo: message.id })
  throw new Error(note)
}
