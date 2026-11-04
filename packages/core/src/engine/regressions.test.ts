import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gate, human, script } from '../dsl.js'
import { initProject } from '../store/project.js'
import type { HarnessAdapter, NodeDef, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-regressions-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '审查回归' })
  return { stores, requirementId: requirement.id }
}
const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'regressions', title: '审查回归', version: '1', stages: [], nodes })

it('rubric 写权限违规不能被 onFail=human 和 autoApprove 放行', async () => {
  const { stores, requirementId } = await fixture()
  const mock: HarnessAdapter = {
    id: 'mock', displayName: 'mock', available: async () => ({ ok: true }),
    run: async (req) => {
      await writeFile(join(req.cwd, 'forbidden.txt'), '越界')
      return { ok: true, finalText: '```json\n{"score":100,"pass":true,"message":"通过"}\n```' }
    },
  }
  const engine = createEngine({ stores, harnesses: { mock }, knowledge: [], profiles: {
    reviewer: { role: 'reviewer', title: '评审', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' } },
  } }, { autoApprove: true })
  const state = await engine.start({ requirementId, workflow: workflow([gate({
    id: 'rubric', title: '评分', onFail: 'human', checks: [{ id: 'check', kind: 'rubric', role: 'reviewer', threshold: 80, rubric: '评审' }],
  })]) })
  expect(state.status).toBe('failed')
  expect(state.nodes.rubric?.status).toBe('blocked')
  expect(await stores.attention.list()).toEqual([])
  expect(await stores.events.read(state.runId, { types: ['guard.violation'] })).toHaveLength(1)
})

it('取消 shell 时终止后台子进程，返回 cancelled 后不会延迟写文件', async () => {
  const { stores, requirementId } = await fixture()
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const program = "const fs=require('node:fs');fs.writeFileSync('started.txt','started');setTimeout(()=>fs.writeFileSync('late.txt','late'),500)"
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const running = engine.start({ requirementId, workflow: workflow([script({
    id: 'background', title: '后台进程', run: `${quote(process.execPath)} -e ${quote(program)} & wait`,
  })]) })
  void running.catch(() => undefined)
  const deadline = Date.now() + 5000
  while (!await readFile(join(stores.projectDir, 'started.txt')).then(() => true, () => false)) {
    if (Date.now() > deadline) throw new Error('子进程启动超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const [state] = await stores.runs.list()
  await engine.cancel(state!.runId)
  expect((await running).status).toBe('cancelled')
  await new Promise((resolve) => setTimeout(resolve, 600))
  await expect(readFile(join(stores.projectDir, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('取消发生在 attention.create 期间，晚到请求关闭且节点保持 cancelled', async () => {
  const { stores, requirementId } = await fixture()
  let notify: (id: string) => void = () => undefined
  const entered = new Promise<string>((resolve) => { notify = resolve })
  let release: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const create = stores.attention.create.bind(stores.attention)
  stores.attention.create = async (input) => { notify(input.runId); await barrier; return create(input) }
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const running = engine.start({ requirementId, workflow: workflow([human({ id: 'wait', title: '等待', ask: '批准？', form: 'approve' })]) })
  const runId = await entered
  try { await engine.cancel(runId) } finally { release() }
  const state = await running
  expect(state.status).toBe('cancelled')
  expect(state.nodes.wait?.status).toBe('cancelled')
  expect(await stores.attention.list({ pending: true })).toEqual([])
  expect(await stores.events.read(runId, { types: ['human.requested'] })).toHaveLength(1)
  expect(await stores.events.read(runId, { types: ['human.answered'] })).toHaveLength(1)
})

it('旧执行晚到的异常不覆盖 stale，恢复会按新的输入版本重新执行', async () => {
  const { stores, requirementId } = await fixture()
  const ref = { workspace: requirementId, path: 'input.txt' }
  await stores.workspaces.writeArtifact({ ref, content: 'v1', kind: 'input', author: { type: 'system', id: 'fixture' } })
  let notify: (id: string) => void = () => undefined
  const entered = new Promise<string>((resolve) => { notify = resolve })
  let release: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const definition = workflow([script({ id: 'read', title: '读取', inputs: [{ path: 'input.txt' }], run: async (ctx) => {
    if (++calls === 1) { notify(ctx.runId); await barrier; throw new Error('旧执行失败') }
    return { data: await ctx.readArtifact('input.txt') }
  } })])
  const deps = { stores, profiles: {}, harnesses: {}, knowledge: [] }
  const engine = createEngine(deps)
  const running = engine.start({ requirementId, workflow: definition })
  const runId = await entered
  try {
    await stores.workspaces.writeArtifact({ ref, content: 'v2', kind: 'input', author: { type: 'system', id: 'fixture' } })
    await engine.markStale(runId, ref)
  } finally { release() }
  expect((await running).nodes.read?.status).toBe('stale')
  const resumed = await createEngine(deps).resume(runId, definition)
  expect(resumed.status).toBe('succeeded')
  expect(resumed.nodes.read?.result).toBe('v2')
  expect(resumed.nodes.read?.inputs?.[0]?.version).toBe(2)
  expect(calls).toBe(2)
})
