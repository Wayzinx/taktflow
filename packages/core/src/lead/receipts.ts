import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { RoomMessage } from '../types.js'
import { withFileLock } from '../store/file-lock.js'

export const DEFAULT_RECEIPT_TIMEOUT_MINUTES = 30
const executing = new Map<string, number>()
const executionKey = (stores: ProjectStores, runId: string) => join(stores.taktDir, 'runs', runId)

// 多个 openProject 实例共用进程内身份；磁盘上的 running 不能证明本进程还在执行。
export function trackTaskExecution(stores: ProjectStores, runId: string): () => void {
  const key = executionKey(stores, runId)
  executing.set(key, (executing.get(key) ?? 0) + 1)
  return () => {
    const count = executing.get(key)! - 1
    if (count) executing.set(key, count)
    else executing.delete(key)
  }
}

export function withTaskReceiptLock<T>(stores: ProjectStores, requirementId: string, work: () => Promise<T>): Promise<T> {
  return withFileLock(join(stores.taktDir, 'chat', requirementId, 'task-receipts'), work)
}

async function reconcileReceipts(stores: ProjectStores, noteFor: (message: RoomMessage) => Promise<string | undefined>, status: 'expired' | 'uncertain'): Promise<RoomMessage[]> {
  const updated: RoomMessage[] = []
  for (const requirement of await stores.workspaces.listRequirements()) {
    await withTaskReceiptLock(stores, requirement.id, async () => {
      const latest = new Map<string, RoomMessage>()
      for (const message of await stores.chat.list(requirement.id)) {
        if (message.kind !== 'task' || !message.refs?.taskRunId || !message.receipt) continue
        const previous = latest.get(message.refs.taskRunId)
        if (!previous || message.seq > previous.seq) latest.set(message.refs.taskRunId, message)
      }
      for (const message of latest.values()) {
        const note = await noteFor(message)
        if (!note) continue
        updated.push(await stores.chat.post(requirement.id, {
          author: { type: 'system', id: 'lead' }, kind: 'task', text: note,
          replyTo: message.id, refs: message.refs, receipt: { ...message.receipt!, status, note },
        }))
      }
    })
  }
  return updated
}

export function expireTaskReceipts(stores: ProjectStores, now = Date.now()): Promise<RoomMessage[]> {
  const minutes = stores.config.lead?.receiptTimeoutMinutes ?? DEFAULT_RECEIPT_TIMEOUT_MINUTES
  return reconcileReceipts(stores, async message => {
    if (message.receipt!.status !== 'sent' || !(now - Date.parse(message.at) >= minutes * 60_000)) return
    return `任务超过 ${minutes} 分钟无人接手，回执已过期；请先查看群聊，再决定是否重发`
  }, 'expired')
}

export function recoverTaskReceipts(stores: ProjectStores): Promise<RoomMessage[]> {
  return reconcileReceipts(stores, async message => {
    if (!['sent', 'taken'].includes(message.receipt!.status)) return
    const runId = message.refs!.taskRunId!
    const state = await stores.runs.get(runId)
    if (state?.requirementId === message.roomId && (['succeeded', 'failed', 'cancelled'].includes(state.status) || executing.has(executionKey(stores, runId)))) return
    return '服务重启，可能已送达，重发前先看群聊'
  }, 'uncertain')
}
