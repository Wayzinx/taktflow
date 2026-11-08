import { expect, it } from 'vitest'
import type { RoomMessage } from '../types.js'
import { assertTaskResendable, TaskResendConflictError } from './delegation.js'

function message(id: string, seq: number, runId: string, status: NonNullable<RoomMessage['receipt']>['status'], replyTo = 'trigger'): RoomMessage {
  return { id, seq, roomId: 'REQ-1', at: '2026-11-08T00:00:00Z', author: { type: 'system', id: 'test' }, kind: 'task', text: id,
    refs: { taskRunId: runId, runId }, replyTo, receipt: { status } }
}

it('同一触发消息派发的其他任务不影响当前回执，正常状态回复不算重发', () => {
  const original = message('original', 1, 'a', 'sent')
  const messages = [original, message('started', 2, 'a', 'started', original.id), message('expired', 3, 'a', 'expired', original.id), message('other', 4, 'b', 'done')]
  expect(() => assertTaskResendable(messages, original)).not.toThrow()
})

it('跨 taskRunId 的回复链按最新回执判断，只能重发最新尝试', () => {
  const original = message('original', 1, 'a', 'expired')
  const retry = message('retry', 2, 'b', 'sent', original.id)
  const messages = [original, retry]
  expect(() => assertTaskResendable(messages, original)).toThrow(TaskResendConflictError)
  expect(() => assertTaskResendable(messages, retry)).toThrow(TaskResendConflictError)
  messages.push(message('uncertain', 3, 'b', 'uncertain', retry.id))
  expect(() => assertTaskResendable(messages, original)).toThrow(TaskResendConflictError)
  expect(() => assertTaskResendable(messages, retry)).not.toThrow()
})

it('旧版沿用 taskRunId 的复制式重发也阻止再次重发原消息', () => {
  const original = message('original', 1, 'a', 'expired')
  const messages = [original, message('legacy-retry', 2, 'a', 'sent', original.id), message('expired', 3, 'a', 'expired', original.id)]
  expect(() => assertTaskResendable(messages, original)).toThrow(TaskResendConflictError)
})
