import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttentionAlreadyAnsweredError } from './attention-rules.js'
import { FsAttentionStore } from './fs-attention.js'

const item = (requestId: string, fill: Partial<Omit<Parameters<FsAttentionStore['create']>[0], 'requestId'>> = {}) => ({
  requestId,
  runId: 'run-20261104-000001',
  nodeId: 'ask-approval',
  requirementId: 'REQ-001',
  ask: '可以继续吗',
  form: 'approve' as const,
  ...fill,
})

describe('FsAttentionStore', () => {
  let root: string
  let taktDir: string
  let store: FsAttentionStore

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'takt-store-at-'))
    taktDir = path.join(root, '.takt')
    store = new FsAttentionStore(taktDir)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('创建、列出、回答待办', async () => {
    const created = await store.create(item('req-1'))
    expect(created.createdAt).not.toBe('')
    await store.create(item('req-2', { requirementId: 'REQ-002', form: 'answer', choices: ['A', 'B'] }))

    expect((await store.list()).map((i) => i.requestId)).toEqual(['req-1', 'req-2'])
    expect((await store.list({ pending: true }))).toHaveLength(2)
    expect((await store.list({ requirementId: 'REQ-002' })).map((i) => i.requestId)).toEqual(['req-2'])
    expect((await store.list({ requirementId: 'REQ-002' }))[0]?.choices).toEqual(['A', 'B'])

    const answered = await store.answer('req-1', { decision: 'approve', by: { type: 'human', id: 'u1' } })
    expect(answered.decision).toBe('approve')
    expect(answered.answeredAt).not.toBeUndefined()
    expect((await store.list({ pending: true })).map((i) => i.requestId)).toEqual(['req-2'])

    await expect(store.create(item('req-1'))).rejects.toThrow('已存在')
    await expect(store.answer('req-404', { answer: 'x', by: { type: 'human', id: 'u1' } })).rejects.toThrow('不存在')
    await expect(store.answer('带 空格', { answer: 'x', by: { type: 'human', id: 'u1' } })).rejects.toThrow('非法待办 ID')
  })

  it('重复回答被拒绝，首次回答者与决定不变', async () => {
    await store.create(item('req-1'))
    const answered = await store.answer('req-1', { decision: 'reject', by: { type: 'human', id: 'u1' } })
    const before = (await store.list())[0]!
    expect(before).toMatchObject({ decision: 'reject', answeredBy: { type: 'human', id: 'u1' }, answeredAt: answered.answeredAt })
    await expect(store.answer('req-1', { decision: 'approve', by: { type: 'human', id: 'u2' } })).rejects.toBeInstanceOf(AttentionAlreadyAnsweredError)
    const reread = await new FsAttentionStore(taktDir).list()
    expect(reread).toHaveLength(1)
    expect(reread[0]).toEqual(before)
  })

  it('另一个实例能立刻看到写入并回答', async () => {
    const other = new FsAttentionStore(taktDir)
    await store.create(item('req-9', { ask: '跨实例' }))
    expect((await other.list({ pending: true })).map((i) => i.ask)).toEqual(['跨实例'])
    await other.answer('req-9', { decision: 'approve', by: { type: 'human', id: 'u2' } })
    expect((await store.list({ pending: true }))).toEqual([])
  })

  it('动态节点 requestId 允许斜杠，回答者追加到审计记录', async () => {
    const requestId = 'run-1:planner/item/ask'
    await store.create(item(requestId, { nodeId: 'planner/item/ask' }))
    const by = { type: 'human', id: 'reviewer' } as const
    await store.answer(requestId, { answer: '继续', by })
    expect((await new FsAttentionStore(taktDir).list())[0]?.answer).toBe('继续')
    const records = (await readFile(path.join(taktDir, 'attention.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(records).toHaveLength(2)
    expect(records[1].answeredBy).toEqual(by)
    expect(records[1]).not.toHaveProperty('by')
  })
})
