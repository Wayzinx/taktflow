import type { LeadPresence, RoomMessage } from '@taktflow/core'

const FAIL = 'Lead 回合失败：'
const WRAP = 'Lead 回调失败：'
const PRESENCE_FAIL = '上一回合失败：'

/** Lead 回合失败的系统消息：core 写的原文，以及 server 把同一个错误再包一层的那条。 */
export function isLeadFailureText(text: string): boolean {
  return text.startsWith(FAIL) || text.startsWith(WRAP)
}

/** server 的 `Lead 回调失败：Lead 回合失败：…` 只是同一错误的包装，界面上不重复展示。 */
export function isRedundantLeadFailure(m: RoomMessage, messages: RoomMessage[]): boolean {
  return m.kind === 'system' && m.text.startsWith(WRAP) && m.text.includes(FAIL) && messages.some((x) => x.id !== m.id && x.kind === 'system' && x.text.startsWith(FAIL) && x.replyTo === m.replyTo)
}

function reasonOf(text: string): string {
  let t = text
  if (t.startsWith(WRAP)) t = t.slice(WRAP.length)
  if (t.startsWith(FAIL)) t = t.slice(FAIL.length)
  const first = t.split('\n')[0]!.trim()
  return first.length > 160 ? `${first.slice(0, 160)}…` : first
}

export interface LeadTurnFailure {
  /** 一句中文原因（优先取系统消息第一行，其次取 presence.detail）。 */
  reason: string
  /** 能找到触发这一回合的用户消息时，可以原样重发。 */
  retryable: boolean
  trigger?: RoomMessage
  /** 失败系统消息 id：重试后暂时隐藏这条失败提示。 */
  messageId?: string
}

/**
 * 最近一回合是否失败：优先看 LeadPresence 的"上一回合失败"，也兼容只看消息的情况；
 * 之后已有成功的 Lead 回复时不再提示（避免历史失败一直挂着）。
 */
export function leadTurnFailure(messages: RoomMessage[], presence?: LeadPresence): LeadTurnFailure | undefined {
  const failures = messages.filter((m) => m.kind === 'system' && isLeadFailureText(m.text))
  const lastFailure = failures.at(-1)
  const lastReply = messages.filter((m) => m.author.type === 'agent' && m.author.role === 'lead' && (m.kind === 'text' || m.kind === 'progress')).at(-1)
  if (lastFailure && lastReply && lastReply.seq > lastFailure.seq) return undefined
  const presenceFailed = !!presence?.detail?.startsWith(PRESENCE_FAIL)
  if (!lastFailure && !presenceFailed) return undefined
  // 优先用未包装的那条，原因更短更清楚
  const source = [...failures].reverse().find((m) => m.text.startsWith(FAIL)) ?? lastFailure
  const reason = source ? reasonOf(source.text) : presence!.detail!.slice(PRESENCE_FAIL.length)
  const trigger = source?.replyTo ? messages.find((m) => m.id === source.replyTo && m.author.type === 'human') : undefined
  return { reason: reason || '原因未知', retryable: !!trigger?.text, trigger, messageId: source?.id }
}

/** Lead 动作回执：replyTo 指向同一条用户消息的系统消息，挂到对应 Lead 回复气泡下。 */
export interface MessageRow {
  key: string
  m: RoomMessage
}

export function attachLeadReceipts(rows: MessageRow[]): { rows: MessageRow[]; receipts: Map<string, RoomMessage[]> } {
  const leadReplyByTrigger = new Map<string, string>()
  for (const { m } of rows) {
    if (m.author.type === 'agent' && m.author.role === 'lead' && m.kind === 'text' && m.replyTo) leadReplyByTrigger.set(m.replyTo, m.id)
  }
  const receipts = new Map<string, RoomMessage[]>()
  const kept: MessageRow[] = []
  for (const row of rows) {
    const m = row.m
    const target = m.kind === 'system' && m.replyTo ? leadReplyByTrigger.get(m.replyTo) : undefined
    if (target && !isLeadFailureText(m.text)) {
      receipts.set(target, [...(receipts.get(target) ?? []), m])
      continue
    }
    kept.push(row)
  }
  return { rows: kept, receipts }
}

/** 回执失败：动作失败的系统消息都以"失败："结尾，成功以"：成功；"开头。 */
export function receiptFailed(text: string): boolean {
  return /失败|错误|超时|拒绝/.test(text)
}

/** 群里最近一条 Lead 消息用的 harness 是不是测试替身（mock）。 */
export function leadUsesMock(messages: RoomMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.author.type === 'agent' && m.author.role === 'lead')
  return last?.author.type === 'agent' && last.author.harness === 'mock'
}
