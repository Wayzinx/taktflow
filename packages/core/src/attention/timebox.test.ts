import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { createEngine } from '../engine/index.js'
import { tickAttention, timeboxMs } from './timebox.js'
import type { WorkflowDefinition } from '../types.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup(form: 'answer' | 'approve' | 'choice' = 'answer', assumption: string | undefined = '使用 A') {
  const root = await mkdtemp(join(tmpdir(), 'takt-timebox-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.human = { remindAfter: '1m', handbackAfter: '3m' }
  stores.config.members = [{ id: 'dev', name: 'Dev', role: 'member', duties: ['developer'] }]
  const req = await stores.workspaces.createRequirement({ title: '时限', owner: 'owner' })
  const workflow: WorkflowDefinition = { id: 'w', title: 'w', version: '1', stages: [], nodes: [
    { id: 'ask', kind: 'human', ask: '用哪个', form, choices: form === 'choice' ? ['A', 'B'] : undefined, assumption, owner: 'developer' },
    { id: 'next', kind: 'script', needs: ['ask'], run: async ctx => ({ data: ctx.resultOf('ask') }) },
  ] }
  const engine = createEngine({ stores, harnesses: {}, profiles: {}, knowledge: [] })
  const state = await engine.start({ workflow, requirementId: req.id })
  const item = (await stores.attention.list())[0]!
  return { stores, state, item, engine, workflow, time: (minutes: number) => new Date(Date.parse(item.createdAt) + minutes * 60_000) }
}
it('两次提醒、交还、幂等、恢复运行携带假设，人工改答使依赖过期', async () => {
  const { stores, state, item, time, engine, workflow } = await setup()
  expect(item).toMatchObject({ assumption: '使用 A', timebox: { remindAfter: '1m', handbackAfter: '3m' } })
  expect((await tickAttention(stores, time(1))).reminded).toEqual([{ requestId: item.requestId, round: 1, to: ['dev'] }])
  expect((await tickAttention(stores, time(2))).reminded[0]!.to).toEqual(['dev', 'owner'])
  const result = await tickAttention(stores, time(3))
  expect(result.handedBack[0]).toMatchObject({ handedBack: true, answer: '使用 A', answeredBy: { type: 'system' } })
  expect(result.assumptions[0]).toMatchObject({ kind: 'assumption', assumedFor: item.requestId })
  expect((await tickAttention(stores, time(10)))).toMatchObject({ reminded: [], handedBack: [], assumptions: [] })
  const resumed = await engine.resume(state.runId, workflow)
  expect(resumed.status).toBe('succeeded')
  expect(resumed.nodes.next!.result).toMatchObject({ answer: '未获回答，按假设：使用 A', handedBack: true })
  await stores.attention.answer(result.assumptions[0]!.requestId, { by: { type: 'human', id: 'owner' }, answer: '使用 B' })
  const correction = await tickAttention(stores, time(11))
  expect(correction.stale.map(item => item.nodeId)).toEqual(['ask', 'next'])
  expect((await stores.runs.get(state.runId))!.nodes.next!.status).toBe('stale')
  expect((await tickAttention(stores, time(12))).stale).toEqual([])
  const corrected = await engine.resume(state.runId, workflow)
  expect(corrected.status).toBe('succeeded')
  expect(corrected.nodes.next!.result).toMatchObject({ answer: '使用 B' })
  expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
})
it.each(['approve', 'choice'] as const)('%s 永不交还，提醒不无限重复', async form => {
  const { stores, time } = await setup(form)
  expect((await tickAttention(stores, time(30))).handedBack).toEqual([])
  expect(await stores.attention.list({ pending: true })).toHaveLength(1)
  expect((await tickAttention(stores, time(60))).reminded).toEqual([])
})
it('没有假设不交还，人工回答不会被覆盖，并发 tick 不重复', async () => {
  const { stores, item, time } = await setup('answer', '')
  const results = await Promise.all([tickAttention(stores, time(3)), tickAttention(stores, time(3))])
  expect(results.flatMap(result => result.reminded)).toHaveLength(2)
  expect(results.flatMap(result => result.handedBack)).toEqual([])
  await stores.attention.answer(item.requestId, { by: { type: 'human', id: 'owner' }, answer: '人工答案' })
  await tickAttention(stores, time(10))
  expect((await stores.attention.list())[0]!.answer).toBe('人工答案')
})
it('解析时限失败给出可执行提示', () => {
  expect(timeboxMs('2h')).toBe(7200000)
  expect(() => timeboxMs('-1m')).toThrow('30m')
})
