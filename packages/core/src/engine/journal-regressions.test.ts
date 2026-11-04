import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { human, judge, loop, script } from '../dsl.js'
import { initProject, openProject } from '../store/project.js'
import { markArtifactEdited } from '../store/artifact-edits.js'
import type { NodeDef, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'journal', title: '失效恢复', version: '1', stages: [], nodes })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-journal-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '失效恢复' })).id
  const ref = { workspace: requirementId, path: 'spec.txt' }
  await stores.workspaces.writeArtifact({ ref, content: 'v1', kind: 'spec', author: { type: 'system', id: 'test' } })
  const deps = { stores, profiles: {}, knowledge: [], harnesses: {} }
  const edit = async (content: string) => {
    const external = await openProject(root)
    const cause = await external.workspaces.writeArtifact({ ref, content, kind: 'spec', author: { type: 'human', id: 'editor' }, reason: '新版' })
    return { cause, affected: await markArtifactEdited(external, cause, { type: 'human', id: 'editor' }, '新版') }
  }
  return { root, stores, requirementId, ref, deps, edit }
}

it('串行读者分别恢复，前一个不等待尚未执行的后一个读者', async () => {
  const { root, stores, requirementId, deps, edit } = await fixture()
  const executions: string[] = []
  const def = workflow(['a', 'b'].map((id, index) => script({ id, title: id, needs: index ? ['a'] : [], inputs: [{ path: 'spec.txt' }], run: async (ctx) => {
    executions.push(`${id}:${await ctx.readArtifact('spec.txt')}`)
  } })))
  const first = await createEngine(deps).start({ requirementId, workflow: def })
  expect(first.status).toBe('succeeded')
  expect((await edit('v2')).affected.map((item) => item.nodeId).sort()).toEqual(['a', 'b'])
  const resumed = await createEngine({ ...deps, stores: await openProject(root) }).resume(first.runId, def)
  expect(resumed.status).toBe('succeeded')
  expect(executions).toEqual(['a:v1', 'b:v1', 'a:v2', 'b:v2'])
  expect(Object.values(resumed.nodes).map((node) => node.attempts)).toEqual([2, 2])
  expect((await stores.runs.get(first.runId))?.status).toBe('succeeded')
})

it.each(['downstream', 'reader'])('失效后的 %s 在新尝试 when=false，合法 skipped 不被旧墓碑改回 stale', async (skipped) => {
  const { root, stores, requirementId, deps, edit } = await fixture()
  let shouldRun = true
  const calls: string[] = []
  const def = workflow([
    script({ id: 'reader', title: '', when: () => skipped !== 'reader' || shouldRun, inputs: [{ path: 'spec.txt' }], run: async (ctx) => {
      calls.push('reader')
      return { data: await ctx.readArtifact('spec.txt') }
    } }),
    script({ id: 'downstream', title: '', needs: ['reader'], when: () => skipped !== 'downstream' || shouldRun, run: async () => {
      calls.push('downstream')
      return { data: '旧结果' }
    } }),
  ])
  const first = await createEngine(deps).start({ requirementId, workflow: def })
  await edit('v2')
  shouldRun = false
  const resumed = await createEngine({ ...deps, stores: await openProject(root) }).resume(first.runId, def)
  expect(resumed.status).toBe('succeeded')
  expect(resumed.nodes[skipped]).toMatchObject({ status: 'skipped', attempts: 2, inputs: [], outputs: [] })
  expect(resumed.nodes[skipped]?.result).toBeUndefined()
  expect(calls.filter((id) => id === skipped)).toHaveLength(1)
  const persisted = await stores.runs.get(first.runId)
  expect(persisted?.status).toBe('succeeded')
  expect(persisted?.nodes[skipped]?.status).toBe('skipped')
  const finished = await stores.events.read(first.runId, { nodeId: skipped, types: ['node.finished'] })
  expect(finished.at(-1)?.data).toMatchObject({ status: 'skipped', outputs: [] })
})

it('外层新一轮重建内层后 attempts 单调，旧 inner iteration=2 不压住新 iteration=1，暂停后恢复仍保留代际', async () => {
  const { root, stores, requirementId, deps, edit } = await fixture()
  const visits: Array<{ iteration?: number; value?: string }> = []
  const def = workflow([loop({ id: 'outer', title: '', maxIterations: 2, until: (ctx) => ctx.iteration === 2, body: [
    human({ id: 'begin', title: '', ask: '继续本轮？', form: 'approve' }),
    loop({ id: 'inner', title: '', needs: ['begin'], maxIterations: 2, until: (ctx) => ctx.iteration === 2, body: [
      script({ id: 'read', title: '', inputs: [{ path: 'spec.txt' }], run: async (ctx) => { visits.push({ iteration: ctx.iteration, value: await ctx.readArtifact('spec.txt') }) } }),
    ] }),
    human({ id: 'end', title: '', needs: ['inner'], ask: '结束本轮？', form: 'approve' }),
  ] })])
  const resume = async (runId: string) => createEngine({ ...deps, stores: await openProject(root) }).resume(runId, def)
  const answer = async (nodeId: string) => {
    const pending = (await stores.attention.list({ pending: true })).filter((item) => item.nodeId === nodeId)
    await stores.attention.answer(pending.at(-1)!.requestId, { decision: 'approve', by: { type: 'human', id: 'reviewer' } })
  }
  let state = await createEngine(deps).start({ requirementId, workflow: def })
  await answer('outer/begin')
  state = await resume(state.runId)
  expect(state.nodes['outer/inner/read']).toMatchObject({ iteration: 2, attempts: 2 })
  await edit('v2')
  state = await resume(state.runId)
  expect(state.nodes['outer/inner/read']).toMatchObject({ status: 'succeeded', iteration: 2, attempts: 3 })
  await answer('outer/end')
  state = await resume(state.runId)
  expect(state.status).toBe('waiting_human')
  expect(state.nodes.outer?.iteration).toBe(2)
  const record = JSON.parse(await readFile(join(root, '.takt/runs', state.runId, 'engine.json'), 'utf8')) as { attempts: Record<string, number> }
  expect(record.attempts['outer/inner/read']).toBe(3)
  await answer('outer/begin')
  state = await resume(state.runId)
  expect(state.nodes['outer/inner/read']).toMatchObject({ status: 'succeeded', iteration: 2, attempts: 5 })
  await answer('outer/end')
  state = await resume(state.runId)
  expect(state.status).toBe('succeeded')
  expect(visits).toEqual([
    { iteration: 1, value: 'v1' }, { iteration: 2, value: 'v1' }, { iteration: 2, value: 'v2' },
    { iteration: 1, value: 'v2' }, { iteration: 2, value: 'v2' },
  ])
  expect((await stores.runs.get(state.runId))?.status).toBe('succeeded')
})

it('输入已经是 v3，迟到的 v2 通知不使节点或下游失效', async () => {
  const { stores, requirementId, ref, deps, edit } = await fixture()
  await edit('v2')
  await edit('v3')
  const def = workflow([
    script({ id: 'reader', title: '', inputs: [{ path: 'spec.txt' }], run: async () => undefined }),
    script({ id: 'after', title: '', needs: ['reader'], run: async () => undefined }),
  ])
  const engine = createEngine(deps)
  const state = await engine.start({ requirementId, workflow: def })
  expect(state.nodes.reader?.inputs).toEqual([{ ...ref, version: 3 }])
  expect(await engine.markStale(state.runId, { ...ref, version: 2 })).toEqual([])
  expect(await markArtifactEdited(stores, { ...ref, version: 2 }, { type: 'human', id: 'editor' }, '迟到通知')).toEqual([])
  expect((await stores.runs.get(state.runId))?.status).toBe('succeeded')
  expect(await stores.events.read(state.runId, { types: ['node.stale', 'artifact.edited'] })).toEqual([])
})


it('改版后 judge 不再路由失败，旧修复节点在新代际 skipped 而非被墓碑改回 stale', async () => {
  const { root, stores, requirementId, deps, edit } = await fixture()
  let fixes = 0
  let judgments = 0
  const judgeDeps = { ...deps, profiles: { judge: { role: 'judge', title: '', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' } } },
    harnesses: { mock: { id: 'mock', displayName: '', available: async () => ({ ok: true }), run: async () => {
      judgments++
      return { ok: true, finalText: '', structured: { verdicts: [{ subject: 'TC-1', category: 'product_bug', confidence: 1, rationale: '证据', evidence: [] }] } }
    } } },
  }
  const def = workflow([
    script({ id: 'run', title: '', inputs: [{ path: 'spec.txt' }], run: async (ctx) => ({ data: { failures: await ctx.readArtifact('spec.txt') === 'v1' ? [{ subject: 'TC-1' }] : [] } }) }),
    judge({ id: 'judge', title: '', role: 'judge', needs: ['run'], target: 'run', routes: { product_bug: 'fix' } }),
    script({ id: 'fix', title: '', needs: ['judge'], run: async () => { fixes++; return { data: '旧修复' } } }),
  ])
  const first = await createEngine(judgeDeps).start({ requirementId, workflow: def })
  expect(first.status).toBe('succeeded')
  await edit('v2')
  const resumed = await createEngine({ ...judgeDeps, stores: await openProject(root) }).resume(first.runId, def)
  expect(resumed.status).toBe('succeeded')
  expect(resumed.nodes.fix).toMatchObject({ status: 'skipped', attempts: 2, inputs: [], outputs: [] })
  expect(resumed.nodes.fix?.result).toBeUndefined()
  expect(fixes).toBe(1)
  expect(judgments).toBe(1)
  expect((await stores.runs.get(first.runId))?.nodes.fix?.status).toBe('skipped')
})
