import { describe, expect, it } from 'vitest'
import type { StewardMessage } from '@taktflow/core'
import { applyStreamEvent, mergeDetail, settleLocal } from '../src/components/steward/thread-reducer'

const msg = (id: string, role: StewardMessage['role'], text: string, extra: Partial<StewardMessage> = {}): StewardMessage => ({ id, threadId: 't', role, at: '2026-11-07T00:00:00Z', text, ...extra })

describe('thread reducer', () => {
  const local = msg('local-1', 'user', '你好')
  const server = msg('u-uuid', 'user', '你好')

  it('stream user message arrives before POST returns: one message, no duplicate ids', () => {
    let list = [msg('s1', 'steward', 'hi'), local]
    list = applyStreamEvent(list, { type: 'message', message: server })
    list = settleLocal(list, local.id, server)
    expect(list.map((m) => m.id)).toEqual(['s1', 'u-uuid'])
  })
  it('POST returns before the stream echo: still one message', () => {
    let list = [msg('s1', 'steward', 'hi'), local]
    list = settleLocal(list, local.id, server)
    list = applyStreamEvent(list, { type: 'message', message: server })
    expect(list.map((m) => m.id)).toEqual(['s1', 'u-uuid'])
  })
  it('detail reload drops locals the server already has', () => {
    expect(mergeDetail([local], [server]).map((m) => m.id)).toEqual(['u-uuid'])
  })
  it('streams deltas, tools and done onto the steward message', () => {
    let list = applyStreamEvent([], { type: 'message', message: msg('s2', 'steward', '', { status: 'streaming' }) })
    list = applyStreamEvent(list, { type: 'delta', messageId: 's2', text: '好' })
    list = applyStreamEvent(list, { type: 'tool', messageId: 's2', tool: { id: 'k1', name: 'list', input: {}, status: 'running' } as never })
    list = applyStreamEvent(list, { type: 'tool', messageId: 's2', tool: { id: 'k1', name: 'list', input: {}, status: 'done' } as never })
    list = applyStreamEvent(list, { type: 'done', messageId: 's2' })
    expect(list[0]).toMatchObject({ text: '好', status: 'done', tools: [{ id: 'k1', status: 'done' }] })
  })
  it('delta reset clears the streamed narration before the answer', () => {
    let list = applyStreamEvent([], { type: 'message', message: msg('s4', 'steward', '', { status: 'streaming' }) })
    list = applyStreamEvent(list, { type: 'delta', messageId: 's4', text: '我先查一下。' })
    list = applyStreamEvent(list, { type: 'delta', messageId: 's4', text: '', reset: true })
    list = applyStreamEvent(list, { type: 'delta', messageId: 's4', text: '答案' })
    expect(list[0]!.text).toBe('答案')
  })
  it('upserts delegations by chat message id', () => {
    const d = { spaceId: 'shop', requirementId: 'REQ-1', messageId: 'c1', status: 'sent' as const, at: 'x' }
    let list = [msg('s3', 'steward', '已转达')]
    list = applyStreamEvent(list, { type: 'delegation', messageId: 's3', delegation: d })
    list = applyStreamEvent(list, { type: 'delegation', messageId: 's3', delegation: { ...d, status: 'answered', reply: '好的' } })
    expect(list[0]!.delegations).toEqual([{ ...d, status: 'answered', reply: '好的' }])
  })
  it('a stale streaming snapshot from the detail fetch does not wipe a finished message (tools / proposals kept)', () => {
    const done = msg('s3', 'steward', '已生成提案[1]', { status: 'done', tools: [{ id: 'k1', tool: 'propose' } as never], proposalIds: ['p1'] })
    const stale = msg('s3', 'steward', '', { status: 'streaming', tools: [], proposalIds: [] })
    expect(mergeDetail([done], [stale])[0]).toMatchObject({ status: 'done', proposalIds: ['p1'], text: '已生成提案[1]' })
    // 反过来：详情比流新时照常合并，工具卡按 id 合并而不是被覆盖
    const newer = msg('s3', 'steward', '已生成提案[1]，等你批准', { status: 'done', tools: [{ id: 'k2', tool: 'list' } as never] })
    expect(mergeDetail([done], [newer])[0]!.tools!.map((t) => t.id)).toEqual(['k1', 'k2'])
  })
})
