import { randomUUID } from 'node:crypto'
import { sha256 } from '@taktflow/core'
import { FeishuQueueStore } from './feishu-queue-store.js'
import type { FeishuEvent } from './feishu-wire.js'

type Message = { type: 'text' | 'interactive'; content: Record<string, unknown> }

export interface FeishuEnvelope {
  key: string
  spaceId: string
  chatId: string
  revision: string
  memberId?: string
  event?: FeishuEvent
  message?: Message
}

interface Services {
  // 回调须校验当前绑定和成员；prepare 可能在崩溃后重放，以 envelope.key 保证业务幂等。
  prepare: (envelope: FeishuEnvelope) => Promise<Message | undefined>
  deliver: (envelope: FeishuEnvelope, message: Message, dedupId: string) => Promise<void>
}

const retryDelays = [1_000, 5_000, 15_000, 60_000, 300_000]
const maxAttempts = retryDelays.length + 1
const sendWindow = 55 * 60_000 // 飞书 UUID 有效期为一小时，预留请求耗时。
const receiptLifetime = 7 * 24 * 60 * 60_000
const sweepInterval = 60 * 60_000
const storageRetry = 5_000
const maxActiveChats = 8

interface Pending {
  state: 'pending'
  sequence: number
  envelope: FeishuEnvelope
  uuid: string
  attempt: number
  retryAt: number
  message?: Message
  firstSendAt?: number
}

type DeadReason = 'prepare-failed' | 'delivery-failed' | 'delivery-window-expired'
interface Receipt { state: 'done' | 'dead'; expiresAt: number; reason?: DeadReason }

function filename(key: string): string { return `${sha256(key)}.json` }
function natural(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

function isMessage(value: unknown): value is Message {
  const message = value as Partial<Message> | null
  return (message?.type === 'text' || message?.type === 'interactive')
    && typeof message.content === 'object' && message.content !== null && !Array.isArray(message.content)
}

function readRecord(name: string, value: unknown): Pending | Receipt {
  const record = value as Partial<Pending | Receipt> | null
  if ((record?.state === 'done' || record?.state === 'dead') && natural(record.expiresAt)) return record as Receipt
  if (record?.state === 'pending' && natural(record.sequence) && natural(record.attempt) && natural(record.retryAt)
    && (record.firstSendAt === undefined || (natural(record.firstSendAt) && record.message !== undefined))
    && (record.message === undefined || isMessage(record.message))
    && typeof record.uuid === 'string' && /^[a-f0-9-]{36}$/.test(record.uuid)
    && typeof record.envelope?.key === 'string' && filename(record.envelope.key) === name
    && typeof record.envelope.spaceId === 'string' && typeof record.envelope.chatId === 'string'
    && typeof record.envelope.revision === 'string') return record as Pending
  throw new Error(`飞书队列记录损坏：${name}`)
}

function retryable(error: unknown): boolean {
  return !(typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false)
}

function outsideSendWindow(entry: Pending, now: number): boolean {
  return entry.firstSendAt !== undefined && (now < entry.firstSendAt || now - entry.firstSendAt >= sendWindow)
}

export class FeishuQueue {
  private readonly store: FeishuQueueStore
  private readonly pending = new Map<string, Pending>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly active = new Map<string, Promise<void>>()
  private initialized?: Promise<void>
  private putTail: Promise<void> = Promise.resolve()
  private scan?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private sequence = 0
  private nextSweep = 0
  private rescan = false
  private started = false
  private closed = false

  constructor(root: string, private readonly services: Services) { this.store = new FeishuQueueStore(root) }

  put(envelope: FeishuEnvelope): Promise<void> {
    if (this.closed) return Promise.reject(new Error('飞书队列已关闭'))
    const put = this.putTail.then(async () => {
      await this.load()
      const name = filename(envelope.key)
      const entry: Pending = { state: 'pending', sequence: ++this.sequence, envelope, uuid: randomUUID(),
        attempt: 0, retryAt: 0, message: envelope.message }
      const saved = await this.store.save(name, entry, true)
      if (saved) this.pending.set(name, saved)
      else if (!this.pending.has(name) && !this.receipts.has(name)) this.remember(name, await this.store.read(name))
      if (this.started) this.kick()
    })
    this.putTail = put.catch(() => undefined)
    return put
  }

  start(): void { this.kick() }

  kick(): void {
    if (this.closed) return
    this.started = true
    this.rescan = true
    if (this.scan) return
    this.scan = this.drain().catch(() => {
      console.error('飞书队列扫描失败，稍后重试')
      this.wake(Date.now() + storageRetry)
    }).finally(() => {
      this.scan = undefined
      if (this.rescan) this.kick()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    await Promise.all([this.putTail, this.scan, ...this.active.values()])
  }

  private load(): Promise<void> {
    return this.initialized ??= (async () => {
      for (const name of await this.store.list()) {
        try { this.remember(name, await this.store.read(name)) }
        catch { console.error(`无法读取飞书队列记录：${name}`) }
      }
    })().catch(error => {
      this.initialized = undefined
      throw error
    })
  }

  private remember(name: string, value: unknown): void {
    const record = readRecord(name, value)
    if (record.state === 'pending') {
      this.sequence = Math.max(this.sequence, record.sequence)
      this.pending.set(name, record)
    } else this.receipts.set(name, record)
  }

  private async drain(): Promise<void> {
    this.rescan = false
    await this.load()
    if (this.closed) return
    const now = Date.now()
    if (now >= this.nextSweep) await this.prune(now)
    if (this.closed) return

    const heads = new Map<string, [string, Pending]>()
    for (const pair of this.pending) {
      const chatId = pair[1].envelope.chatId
      const head = heads.get(chatId)
      if (!head || pair[1].sequence < head[1].sequence) heads.set(chatId, pair)
    }
    let wakeAt = this.nextSweep
    for (const [chatId, [name, entry]] of heads) {
      if (this.active.size >= maxActiveChats) break
      if (this.active.has(chatId)) continue
      if (entry.retryAt > now) {
        wakeAt = Math.min(wakeAt, entry.retryAt)
        continue
      }
      this.active.set(chatId, this.step(name, entry).catch(() => {
        console.error(`无法保存飞书队列进度：${name}`)
        const pending = this.pending.get(name)
        if (pending) pending.retryAt = Date.now() + storageRetry
      }).finally(() => {
        this.active.delete(chatId)
        this.kick()
      }))
    }
    this.wake(wakeAt)
  }

  private wake(at: number): void {
    clearTimeout(this.timer)
    if (!this.closed) {
      this.timer = setTimeout(() => this.kick(), Math.max(1, at - Date.now()))
      this.timer.unref()
    }
  }

  private async prune(now: number): Promise<void> {
    this.nextSweep = now + sweepInterval
    for (const [name, receipt] of this.receipts) {
      if (this.closed) return
      if (receipt.expiresAt > now) continue
      try {
        await this.store.remove(name)
        this.receipts.delete(name)
      } catch { console.error(`无法清理飞书队列回执：${name}`) }
    }
  }

  private async step(name: string, entry: Pending): Promise<void> {
    const now = Date.now()
    const failed = entry.message ? 'delivery-failed' : 'prepare-failed'
    if (outsideSendWindow(entry, now)) return this.finish(name, 'delivery-window-expired')
    if (entry.attempt >= maxAttempts) return this.finish(name, failed)

    // 先记尝试次数和第一次发送时间；进程可能在发送返回前退出。
    const next = await this.store.save(name, { ...entry, attempt: entry.attempt + 1,
      retryAt: now + (retryDelays[entry.attempt] ?? 0), firstSendAt: entry.message ? entry.firstSendAt ?? now : undefined })
    this.pending.set(name, next)

    let reply: Message | undefined
    try {
      const envelope = structuredClone(next.envelope)
      if (next.message) {
        if (outsideSendWindow(next, Date.now())) return this.finish(name, 'delivery-window-expired')
        await this.services.deliver(envelope, structuredClone(next.message), next.uuid)
      } else reply = await this.services.prepare(envelope)
    } catch (error) {
      const delay = retryDelays[next.attempt - 1]
      if (!retryable(error) || delay === undefined) return this.finish(name, failed)
      this.pending.set(name, await this.store.save(name, { ...next, retryAt: Date.now() + delay }))
      return
    }

    if (!reply) return this.finish(name)
    this.pending.set(name, await this.store.save(name, { ...next, message: reply, attempt: 0, retryAt: 0 }))
  }

  private async finish(name: string, reason?: DeadReason): Promise<void> {
    const receipt: Receipt = { state: reason ? 'dead' : 'done', expiresAt: Date.now() + receiptLifetime, reason }
    await this.store.save(name, receipt)
    this.pending.delete(name)
    this.receipts.set(name, receipt)
    if (reason) console.warn(`飞书队列记录停止重试：${name} (${reason})`)
  }
}
