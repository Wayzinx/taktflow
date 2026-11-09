import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { script } from '../dsl.js'
import type { EngineDeps } from '../interfaces.js'
import { initProject } from '../store/project.js'
import type { WorkflowDefinition } from '../types.js'
import { recordAnswerOnce } from './answers.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const humanBy = { type: 'human' as const, id: '审批人', via: 'dsh-web' }

interface Project {
  stores: Awaited<ReturnType<typeof initProject>>
  deps: EngineDeps
}

async function project(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'takt-cancel-answers-'))
  roots.push(root)
  const stores = await initProject(root)
  // script 节点不依赖 harness/sandbox 适配器，重复失败同样会触发 Core 的 retry 待办。
  return { stores, deps: { stores, knowledge: [], harnesses: {}, profiles: {} } }
}

/** 同一项目内制造一个 blocked retry：连续两次相同失败后 Core 生成 retry 待办。 */
async function blockedRetry(p: Project, title: string) {
  const requirementId = (await p.stores.workspaces.createRequirement({ title })).id
  let runs = 0
  const definition: WorkflowDefinition = {
    id: `retry-${title}`,
    title,
    version: '1',
    stages: [],
    nodes: [script({ id: 'implement', title: '实现', retry: { max: 5 }, run: async () => { runs += 1; throw new Error('exit 7') } })],
  }
  const engine = createEngine(p.deps)
  const state = await engine.start({ requirementId, workflow: definition })
  expect(state.status).toBe('waiting_human')
  expect(state.nodes.implement).toMatchObject({ status: 'blocked' })
  expect(runs).toBe(2)
  const item = (await p.stores.attention.list({ pending: true })).find((entry) => entry.runId === state.runId)
  expect(item).toMatchObject({ nodeId: 'implement', kind: 'retry', form: 'choice' })
  return { engine, runId: state.runId, item: item!, requirementId, runs: () => runs }
}

it('冷取消补记已落账的真人终止选择，保留原始 actor/答案且不动其它运行', async () => {
  const p = await project()
  const first = await blockedRetry(p, '取消一')
  const second = await blockedRetry(p, '取消二')
  expect([first.runs(), second.runs()]).toEqual([2, 2])

  const answered = await p.stores.attention.answer(first.item.requestId, {
    decision: 'choice', answer: '终止运行', by: humanBy,
  })
  await first.engine.cancel(first.runId)

  const state = await p.stores.runs.get(first.runId)
  expect(state?.status).toBe('cancelled')
  expect(state?.nodes.implement?.status).toBe('cancelled')
  const events = await p.stores.events.read(first.runId)
  expect(events.at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'cancelled' } })
  const audits = await p.stores.events.read(first.runId, { types: ['human.answered'] })
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({
    nodeId: 'implement',
    actor: humanBy,
    data: { requestId: first.item.requestId, decision: 'choice', answer: '终止运行' },
  })
  expect(await p.stores.events.verify(first.runId)).toEqual({ ok: true })
  // 落账记录不被系统取消覆盖。
  expect((await p.stores.attention.list()).find((entry) => entry.requestId === first.item.requestId)).toMatchObject({
    answeredAt: answered.answeredAt,
    answeredBy: humanBy,
    decision: 'choice',
    answer: '终止运行',
  })

  // 另一个运行完全不受影响：状态、待办和审计都不变。
  expect((await p.stores.runs.get(second.runId))?.status).toBe('waiting_human')
  expect((await p.stores.runs.get(second.runId))?.nodes.implement?.status).toBe('blocked')
  expect((await p.stores.attention.list({ pending: true })).map((item) => item.requestId)).toEqual([second.item.requestId])
  expect(await p.stores.events.read(second.runId, { types: ['human.answered'] })).toEqual([])
  // 取消不重放任何节点函数。
  expect([first.runs(), second.runs()]).toEqual([2, 2])
})

it('重复冷取消幂等：已有审计不重复，事件链仍完整', async () => {
  const p = await project()
  const run = await blockedRetry(p, '重复取消')
  const answered = await p.stores.attention.answer(run.item.requestId, {
    decision: 'choice', answer: '终止运行', by: humanBy,
  })
  // 模拟此前的消费已经落过审计：取消只能读回，不能再写第二条。
  await recordAnswerOnce(p.stores, run.runId, answered)

  await run.engine.cancel(run.runId)
  await run.engine.cancel(run.runId)

  expect((await p.stores.runs.get(run.runId))?.status).toBe('cancelled')
  expect(await p.stores.events.read(run.runId, { types: ['human.answered'] })).toHaveLength(1)
  expect(await p.stores.events.verify(run.runId)).toEqual({ ok: true })
})

it('冷取消未回答的待办沿用系统 cancelled 语义，不伪造人工选择', async () => {
  const p = await project()
  const run = await blockedRetry(p, '待回答取消')

  await run.engine.cancel(run.runId)

  const persisted = (await p.stores.attention.list()).find((entry) => entry.requestId === run.item.requestId)
  expect(persisted).toMatchObject({ decision: 'cancelled', answeredBy: { type: 'system', id: 'engine' } })
  expect(persisted?.answer).toBeUndefined()
  const audits = await p.stores.events.read(run.runId, { types: ['human.answered'] })
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({ actor: { type: 'system', id: 'engine' }, data: { requestId: run.item.requestId, decision: 'cancelled' } })
  expect(await p.stores.events.verify(run.runId)).toEqual({ ok: true })
})

it('已成功或已失败的运行取消时保持终态，不补审计', async () => {
  const p = await project()
  const requirementId = (await p.stores.workspaces.createRequirement({ title: '终态' })).id
  const succeededDefinition: WorkflowDefinition = {
    id: 'succeeded', title: '', version: '1', stages: [],
    nodes: [script({ id: 'done', title: '完成', run: async () => {} })],
  }
  const succeeded = await createEngine(p.deps).start({ requirementId, workflow: succeededDefinition })
  expect(succeeded.status).toBe('succeeded')
  await createEngine(p.deps).cancel(succeeded.runId)
  expect((await p.stores.runs.get(succeeded.runId))?.status).toBe('succeeded')
  expect(await p.stores.events.read(succeeded.runId, { types: ['human.answered'] })).toEqual([])
  expect(await p.stores.events.verify(succeeded.runId)).toEqual({ ok: true })

  const failedRequirement = (await p.stores.workspaces.createRequirement({ title: '失败终态' })).id
  const failedDefinition: WorkflowDefinition = {
    id: 'failed', title: '', version: '1', stages: [],
    nodes: [script({ id: 'boom', title: '失败', run: async () => { throw new Error('boom') } })],
  }
  const failed = await createEngine(p.deps).start({ requirementId: failedRequirement, workflow: failedDefinition })
  expect(failed.status).toBe('failed')
  await createEngine(p.deps).cancel(failed.runId)
  expect((await p.stores.runs.get(failed.runId))?.status).toBe('failed')
  expect(await p.stores.events.read(failed.runId, { types: ['human.answered'] })).toEqual([])
  expect(await p.stores.events.verify(failed.runId)).toEqual({ ok: true })
})
