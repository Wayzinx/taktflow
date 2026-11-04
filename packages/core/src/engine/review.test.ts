import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agent, gate, human, loop, script } from '../dsl.js'
import { initProject } from '../store/project.js'
import type { AgentProfile, HarnessAdapter, NodeDef, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-review-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '引擎审查' })
  return { stores, requirementId: requirement.id }
}

const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({
  id: 'review', title: '审查', version: '1', stages: [], nodes,
})
const profile: AgentProfile = {
  role: 'dev', title: '开发', description: '', instructions: '完成任务',
  harness: { harness: 'mock' }, skills: [], writeScope: ['**'],
}

it('脚本覆盖已登记产物后立即读取，得到本轮磁盘内容而不是上轮对象', async () => {
  const { stores, requirementId } = await fixture()
  await stores.workspaces.writeArtifact({
    ref: { workspace: requirementId, path: 'summary.json' },
    content: '{"failures":["old"]}', kind: 'evidence', author: { type: 'system', id: 'fixture' },
  })
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const state = await engine.start({ requirementId, workflow: workflow([
    script({ id: 'run', title: '重新执行', outputs: [{ path: 'summary.json', kind: 'evidence' }], run: async (ctx) => {
      await writeFile(join(ctx.workspaceDir, 'summary.json'), '{"failures":[]}')
      return { data: JSON.parse((await ctx.readArtifact('summary.json'))!) as unknown }
    } }),
  ]) })
  expect(state.status).toBe('succeeded')
  expect(state.nodes.run?.result).toEqual({ failures: [] })
  expect(state.nodes.run?.outputs[0]?.version).toBe(2)
})

it('两轮 loop 内人工请求分别批准，上一轮回答不能自动批准下一轮', async () => {
  const { stores, requirementId } = await fixture()
  let executions = 0
  const def = workflow([loop({
    id: 'cycle', title: '两轮确认', maxIterations: 2,
    until: (ctx) => ctx.iteration === 2,
    body: [
      script({ id: 'work', title: '执行', run: async () => { executions++ } }),
      human({ id: 'confirm', title: '确认', needs: ['work'], ask: '批准本轮？', form: 'approve' }),
    ],
  })])
  const deps = { stores, profiles: {}, harnesses: {}, knowledge: [] }
  const first = await createEngine(deps).start({ requirementId, workflow: def })
  expect(first.status).toBe('waiting_human')
  const [request1] = await stores.attention.list({ pending: true })
  expect(request1).toBeDefined()
  await stores.attention.answer(request1!.requestId, { decision: 'approve', by: { type: 'human', id: 'reviewer' } })
  const second = await createEngine(deps).resume(first.runId, def)
  expect(second.status).toBe('waiting_human')
  expect(executions).toBe(2)
  const pending = await stores.attention.list({ pending: true })
  expect(pending).toHaveLength(1)
  expect(pending[0]!.requestId).not.toBe(request1!.requestId)
  await stores.attention.answer(pending[0]!.requestId, { decision: 'approve', by: { type: 'human', id: 'reviewer' } })
  const completed = await createEngine(deps).resume(first.runId, def)
  expect(completed.status).toBe('succeeded')
  expect(executions).toBe(2)
  expect(await stores.events.verify(first.runId)).toEqual({ ok: true })
})

it('retry 注入失败原因，resultSchema 校验最后一个 JSON 代码块', async () => {
  const { stores, requirementId } = await fixture()
  const prompts: string[] = []
  const harness: HarnessAdapter = {
    id: 'mock', displayName: 'mock', available: async () => ({ ok: true }),
    run: async (req) => {
      prompts.push(req.prompt)
      if (prompts.length === 1) return { ok: false, finalText: '', error: '第一次缺少证据' }
      return { ok: true, finalText: '```json\n{"ok":"wrong"}\n```\n最终：\n```json\n{"ok":true}\n```' }
    },
  }
  const state = await createEngine({ stores, profiles: { dev: profile }, harnesses: { mock: harness }, knowledge: [] })
    .start({ requirementId, workflow: workflow([agent({
      id: 'retry', title: '重试', role: 'dev', prompt: '完成验证', retry: { max: 1 },
      resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', enum: [true] } } },
    })]) })
  expect(state.status).toBe('succeeded')
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('上一次失败原因：第一次缺少证据')
  expect(state.nodes.retry?.result).toEqual({ ok: true })
})

it('autoApprove 保留 answer 文本和 human actor，抛错门禁仍先记录失败检查', async () => {
  const { stores, requirementId } = await fixture()
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }, { autoApprove: true })
    .start({ requirementId, workflow: workflow([
      human({ id: 'answer', title: '补充', ask: '补充说明', form: 'answer' }),
      gate({ id: 'gate', title: '门禁', needs: ['answer'], onFail: 'human', checks: [
        { id: 'broken', kind: 'function', fn: async () => { throw new Error('检查器故障') } },
      ] }),
    ]) })
  expect(state.status).toBe('succeeded')
  expect(state.nodes.answer?.result).toMatchObject({ answer: '（自动通过）' })
  const events = await stores.events.read(state.runId)
  expect(events.filter((event) => event.type === 'human.requested')).toHaveLength(2)
  const answered = events.filter((event) => event.type === 'human.answered')
  expect(answered).toHaveLength(2)
  expect(answered.every((event) => event.actor.type === 'human' && event.actor.id === 'auto-approve')).toBe(true)
  expect(events.find((event) => event.type === 'gate.result')?.data).toMatchObject({ pass: false })
})

it('两个容器共享叶子并发额度，容器本身不占用执行槽位', async () => {
  const { stores, requirementId } = await fixture()
  let active = 0
  let peak = 0
  let completed = 0
  const body = (): NodeDef[] => Array.from({ length: 3 }, (_, index) => script({
    id: `job-${index}`, title: '任务', run: async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active--
      completed++
    },
  }))
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }, { concurrency: 2 })
    .start({ requirementId, workflow: workflow([
      loop({ id: 'a', title: 'A', body: body(), until: () => true, maxIterations: 1 }),
      loop({ id: 'b', title: 'B', body: body(), until: () => true, maxIterations: 1 }),
    ]) })
  expect(state.status).toBe('succeeded')
  expect(completed).toBe(6)
  expect(peak).toBeLessThanOrEqual(2)
  expect(peak).toBe(2)
})
