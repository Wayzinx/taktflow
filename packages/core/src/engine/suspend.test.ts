import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agent, defineWorkflow, human, script } from '../dsl.js'
import { initProject } from '../store/project.js'
import type { AgentProfile, HarnessAdapter, HarnessRequest } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-suspend-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '暂停测试' })).id
  const profiles: Record<string, AgentProfile> = { dev: { role: 'dev', title: 'dev', description: '', instructions: 'dev', harness: { harness: 'mock' }, skills: [], writeScope: ['requirements/**'] } }
  return { stores, requirementId, profiles }
}

const harness = (run: (req: HarnessRequest) => Promise<void>): HarnessAdapter => ({
  id: 'mock', displayName: 'mock', capabilities: {}, available: async () => ({ ok: true }),
  run: async (req) => { await run(req); return { ok: true, finalText: 'done' } },
})

it('宿主退出时暂停：已完成节点保留、被打断的节点回到 pending、不发 run.finished；换引擎实例恢复后从断点跑完', async () => {
  const f = await fixture()
  const ran: string[] = []
  const workflow = defineWorkflow({ id: 'w', title: 'w', version: '1', stages: [{ id: 's', title: 's' }], nodes: [
    script({ id: 'a', title: 'a', stage: 's', run: async () => { ran.push('a') } }),
    agent({ id: 'b', title: 'b', stage: 's', needs: ['a'], role: 'dev', prompt: '实现' }),
    script({ id: 'c', title: 'c', stage: 's', needs: ['b'], run: async () => { ran.push('c') } }),
  ] })
  let started!: () => void
  const inB = new Promise<void>((resolve) => { started = resolve })
  // 第一个宿主：b 一直跑，直到被中止
  const first = createEngine({ stores: f.stores, profiles: f.profiles, harnesses: { mock: harness(async (req) => {
    ran.push('b')
    started()
    await new Promise((_, reject) => req.signal!.addEventListener('abort', () => reject(req.signal!.reason), { once: true }))
  }) }, knowledge: [] })
  const running = first.start({ requirementId: f.requirementId, workflow })
  await inB
  const runId = (await f.stores.runs.list())[0]!.runId
  expect(await first.suspend!(runId)).toBe(true)
  const paused = await running
  expect(paused.status).toBe('running')
  expect(paused.nodes.a!.status).toBe('succeeded')
  expect(paused.nodes.b!.status).toBe('pending')
  expect(paused.nodes.c!.status).toBe('pending')
  const events = await f.stores.events.read(runId)
  expect(events.some((event) => event.type === 'run.finished')).toBe(false)
  expect(events.some((event) => event.type === 'node.failed')).toBe(false)
  expect(await first.suspend!(runId)).toBe(false)

  // 第二个宿主（新进程）：恢复后只重跑 b，a 不重跑
  const second = createEngine({ stores: f.stores, profiles: f.profiles, harnesses: { mock: harness(async () => { ran.push('b') }) }, knowledge: [] })
  const done = await second.resume(runId, workflow)
  expect(done.status).toBe('succeeded')
  expect(ran).toEqual(['a', 'b', 'b', 'c'])
  expect(await f.stores.events.verify(runId)).toEqual({ ok: true })
})

it('等人的待办在暂停后保持未答，恢复后回答照常推进；cancel 语义不变', async () => {
  const f = await fixture()
  const workflow = defineWorkflow({ id: 'h', title: 'h', version: '1', stages: [{ id: 's', title: 's' }], nodes: [
    human({ id: 'approve', title: '审批', stage: 's', ask: '批准？', form: 'approve' }),
    script({ id: 'after', title: 'after', stage: 's', needs: ['approve'], run: async () => {} }),
  ] })
  const engine = createEngine({ stores: f.stores, profiles: f.profiles, harnesses: { mock: harness(async () => {}) }, knowledge: [] })
  const waiting = await engine.start({ requirementId: f.requirementId, workflow })
  expect(waiting.status).toBe('waiting_human')
  // 没有在途执行：暂停返回 false，什么都不改
  expect(await engine.suspend!(waiting.runId)).toBe(false)
  const item = (await f.stores.attention.list({ pending: true }))[0]!
  await f.stores.attention.answer(item.requestId, { decision: 'approve', by: { type: 'human', id: 'u' } })
  const resumed = await createEngine({ stores: f.stores, profiles: f.profiles, harnesses: {}, knowledge: [] }).resume(waiting.runId, workflow)
  expect(resumed.status).toBe('succeeded')
})
