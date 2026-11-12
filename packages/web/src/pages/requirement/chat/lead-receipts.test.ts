import { expect, it } from 'vitest'
import type { RoomMessage } from '@taktflow/core'
import { attachLeadReceipts, isRedundantLeadFailure, leadTurnFailure, leadUsesMock, receiptFailed } from './lead-receipts'

let seq = 0
const msg = (patch: Partial<RoomMessage>): RoomMessage => ({
  id: `m${++seq}`,
  roomId: 'REQ-1',
  seq,
  author: { type: 'human', id: 'web' },
  at: '',
  kind: 'text',
  text: '',
  ...patch,
} as RoomMessage)
const lead = (patch: Partial<RoomMessage> = {}) => msg({ author: { type: 'agent', role: 'lead', harness: 'claude-code' }, ...patch })

it('Lead 动作回执挂到对应的 Lead 气泡，失败回执带失败标记（TF-095）', () => {
  const ask = msg({ text: '@lead 开始', mentions: ['lead'] })
  const reply = lead({ replyTo: ask.id, text: '按改动形状选择流程并启动。' })
  const receipt = msg({ kind: 'system', author: { type: 'system', id: 'lead' }, replyTo: ask.id, text: 'start_run：成功；已启动 run-1' })
  const failed = msg({ kind: 'system', author: { type: 'system', id: 'lead' }, replyTo: ask.id, text: 'Lead start_run失败：没有支持 T2 的 workflow' })
  const { rows, receipts } = attachLeadReceipts([{ key: ask.id, m: ask }, { key: reply.id, m: reply }, { key: receipt.id, m: receipt }, { key: failed.id, m: failed }])
  expect(rows.map((r) => r.m.id)).toEqual([ask.id, reply.id])
  expect(receipts.get(reply.id)?.map((m) => m.text)).toEqual([receipt.text, failed.text])
  expect(receiptFailed(receipt.text)).toBe(false)
  expect(receiptFailed(failed.text)).toBe(true)
})

it('回合失败消息不挂回执，并压成一句中文原因（TF-062）', () => {
  const ask = msg({ text: '@lead 开始', mentions: ['lead'] })
  const fail = msg({ kind: 'system', author: { type: 'system', id: 'lead' }, replyTo: ask.id, text: 'Lead 回合失败：登录或认证失败。去空间设置 › 模型与 Harness 重新登录。\n原因：OAuth session expired' })
  const wrapped = msg({ kind: 'system', author: { type: 'system', id: 'server' }, replyTo: ask.id, text: `Lead 回调失败：${fail.text}` })
  const { rows } = attachLeadReceipts([{ key: ask.id, m: ask }, { key: fail.id, m: fail }, { key: wrapped.id, m: wrapped }])
  expect(rows.map((r) => r.m.id)).toEqual([ask.id, fail.id, wrapped.id])
  expect(isRedundantLeadFailure(wrapped, [ask, fail, wrapped])).toBe(true)
  expect(leadTurnFailure([ask, fail, wrapped])).toMatchObject({ reason: '登录或认证失败。去空间设置 › 模型与 Harness 重新登录。', retryable: true })
})

it('之后已有成功的 Lead 回复时不再提示历史失败（TF-062）', () => {
  const ask = msg({ text: '@lead 开始' })
  const fail = msg({ kind: 'system', author: { type: 'system', id: 'lead' }, replyTo: ask.id, text: 'Lead 回合失败：登录或认证失败。' })
  const ok = lead({ replyTo: ask.id, text: '已经派发了。' })
  expect(leadTurnFailure([ask, fail, ok])).toBeUndefined()
})

it('只有 presence 说上一回合失败时也能给出提示（TF-062）', () => {
  const failure = leadTurnFailure([], { state: 'idle', since: '', detail: '上一回合失败：登录或认证失败' })
  expect(failure).toMatchObject({ reason: '登录或认证失败', retryable: false })
})

it('最近一条 Lead 消息用 mock harness 时标记为演示（TF-095）', () => {
  expect(leadUsesMock([lead({ author: { type: 'agent', role: 'lead', harness: 'mock' } })])).toBe(true)
  expect(leadUsesMock([lead()])).toBe(false)
  expect(leadUsesMock([lead({ author: { type: 'agent', role: 'lead', harness: 'mock' } }), lead()])).toBe(false)
})
