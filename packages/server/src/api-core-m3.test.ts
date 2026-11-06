import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  acquireLease, createCommandRegistry, createEngine, initProject, readLease, releaseLease, waitDefectAttribution, waitEvalRun, withSpaceLease,
  type Actor, type AgentProfile, type DefectDetail, type EngineDeps, type EvalRun, type HarnessAdapter,
} from '@taktflow/core'
import { createApiCore, type WriteOp } from './api-core.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const actor: Actor = { type: 'human', id: 'owner', via: 'dsh-web' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-host-m3-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: 'M3 宿主' })
  return { root, stores, req }
}

it.each<WriteOp>(['command.run', 'route.preview', 'lesson.update', 'review.dispose', 'eval.collect', 'eval.run', 'defect.report', 'defect.attribute', 'defect.confirm', 'space.repo.update'])('%s 在解析请求或写审计前拒绝占用空间', async (op) => {
  const { stores } = await fixture()
  const body = vi.fn(() => ({}))
  const api = createApiCore({ withWriteLease: (stores, task) => withSpaceLease(stores.taktDir, 'host', task) })
  await acquireLease(stores.taktDir, 'other')
  try { await expect(api.write(stores, op, {}, body, actor)).rejects.toMatchObject({ status: 409 }) }
  finally { await releaseLease(stores.taktDir, 'other') }
  expect(body).not.toHaveBeenCalled()
  await expect(readFile(join(stores.taktDir, 'space-events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('命令注册表默认租约覆盖扩展命令和查询审计', async () => {
  const { stores } = await fixture()
  const audit = vi.fn(), handler = vi.fn()
  const commands = createCommandRegistry({ stores, audit, extensions: [{ id: 'new.write', title: '', kind: 'command', risk: 'write', input: { type: 'object' }, handler }] })
  await acquireLease(stores.taktDir, 'other')
  try {
    await expect(commands.run('new.write', {}, { actor, reason: '扩展' })).rejects.toThrow('空间正被')
    await expect(commands.run('attention.list', {}, { actor })).rejects.toThrow('空间正被')
  } finally { await releaseLease(stores.taktDir, 'other') }
  expect(audit).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled()
})

it.each(['eval.run', 'defect.attribute'] as const)('%s 未接入运行时仍返回 M3 的 501', async (op) => {
  const { stores } = await fixture()
  await expect(createApiCore().write(stores, op, {}, {}, actor)).rejects.toMatchObject({ status: 501, message: '未接入评测运行时' })
})

it.each(['eval.run', 'defect.attribute'] as const)('%s 返回初始记录后持有租约直到后台落盘，M3 读操作和 Actor 可回读', async (op) => {
  const { stores, req } = await fixture()
  let unblock!: () => void
  let block = false
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  const profiles = Object.fromEntries(['dev', 'auditor', 'evaluator'].map((role): [string, AgentProfile] => [role, {
    role, title: role, description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock', model: role },
  }]))
  const harness: HarnessAdapter = { id: 'mock', displayName: 'Mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: async (request) => {
    if (block) await gate
    if (request.env?.TAKT_ROLE === 'auditor') return { ok: true, finalText: '', structured: { introducedAt: { origin: 'implementation', nodeId: 'write', evidence: ['spec/a.md'] }, missedBy: [], confidence: 0.9, suggestions: [] } }
    if (request.env?.TAKT_ROLE === 'evaluator') return { ok: true, finalText: '', structured: { checks: [], score: 100, reason: '冻结输出' } }
    await mkdir(join(request.env!.TAKT_WORKSPACE!, 'spec'), { recursive: true })
    await writeFile(join(request.env!.TAKT_WORKSPACE!, 'spec/a.md'), 'AC-1：边界')
    return { ok: true, finalText: '完成' }
  } }
  const deps: EngineDeps = { stores, profiles, harnesses: { mock: harness }, knowledge: [] }
  const run = await createEngine(deps).start({ requirementId: req.id, workflow: { id: 'flow', title: '', version: '1', stages: [], nodes: [
    { id: 'write', kind: 'agent', title: '', role: 'dev', prompt: '写规格', outputs: [{ path: 'spec/a.md', kind: 'spec' }] },
  ] } })
  const api = createApiCore({ resolveRuntime: () => deps, withWriteLease: (stores, task) => withSpaceLease(stores.taktDir, 'host', task) })
  expect(await api.read(stores, 'me', {}, actor)).toMatchObject({ id: 'owner', member: { role: 'owner' } })
  expect(await api.read(stores, 'recipe', { runId: run.runId, nodeId: 'write' })).toMatchObject({ nodeId: 'write', recipeKey: expect.any(String) })
  expect(await api.read(stores, 'eval.scorecards', {})).toHaveLength(1)
  const defect = await api.write(stores, 'defect.report', { id: req.id }, { title: '边界', description: '缺少边界', severity: 'major', reason: '宿主录入' }, actor) as DefectDetail
  expect((await api.read(stores, 'defect', { id: req.id, defectId: defect.id }) as DefectDetail).reportedBy).toEqual(actor)
  await api.write(stores, 'artifact.edit', { id: req.id, path: 'spec/a.md' }, { content: 'AC-1：人工补充边界', reason: '人工修订形成回放样本' }, actor)
  await api.write(stores, 'eval.collect', {}, {}, actor)
  expect(await api.read(stores, 'eval.cases', { target: 'node:flow/write' })).toHaveLength(1)
  block = true
  let finished: Promise<unknown> | undefined
  try {
    const started = await api.write(stores, op, { id: req.id, defectId: defect.id }, op === 'eval.run'
      ? { target: { kind: 'node', workflowId: 'flow', nodeId: 'write' }, variants: [{ id: 'baseline', label: '基线' }], reason: '宿主回放' }
      : { reason: '宿主归因' }, actor)
    expect(started).toMatchObject(op === 'eval.run' ? { status: 'running' } : { attributing: true })
    finished = op === 'eval.run' ? waitEvalRun(stores, (started as EvalRun).id) : waitDefectAttribution(stores, req.id, defect.id)
    expect((await acquireLease(stores.taktDir, 'other')).ok).toBe(false)
    expect((await readLease(stores.taktDir))?.owner).toBe('host')
  } finally { unblock(); await finished }
  await vi.waitFor(async () => expect(await readLease(stores.taktDir)).toBeUndefined())
  expect(await stores.events.verify(run.runId)).toEqual({ ok: true })
  const audit = await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')
  expect(audit).toContain(op === 'eval.run' ? '宿主回放' : '宿主归因')
  const file = join(stores.taktDir, 'runs', run.runId, 'events.jsonl')
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  await writeFile(file, lines.slice(0, -1).join('\n') + '\n')
  expect(await stores.events.verify(run.runId)).toMatchObject({ ok: false, reason: 'truncated' })
  await expect(stores.events.append(run.runId, { type: 'log', actor, data: { level: 'info', message: '不能覆盖锚点' } })).rejects.toThrow('锚点')
})
