import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RunState, WorkflowSnapshot } from '../types.js'
import { initProject } from './project.js'
import { markArtifactEdited } from './artifact-edits.js'
import { loadRunGraph } from './run-graph.js'
import { FsRunStore } from './fs-runs.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const actor = { type: 'human', id: 'reviewer' } as const
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-edits-')); roots.push(root)
  const stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-1', title: 'test' })
  return stores
}
const snapshot: WorkflowSnapshot = { id: 'w', title: 'W', version: '1', stages: [], nodes: [
  { id: 'plan', kind: 'planner', title: 'Plan', needs: [] },
  { id: 'after', kind: 'script', title: 'After', needs: ['plan'] },
  { id: 'other', kind: 'script', title: 'Other', needs: [] },
] }
const input = { workspace: 'REQ-1', path: 'spec/a.md', version: 1 }
function state(runId: string): RunState { return { runId, workflowId: 'w', workflowVersion: '1', requirementId: 'REQ-1', status: 'succeeded', startedAt: '', args: {}, expansions: [{ plannerId: 'plan', items: [], nodeIds: ['plan/a/read', 'plan/a/sibling'], at: '' }], nodes: Object.fromEntries(['plan', 'plan/a/read', 'plan/a/sibling', 'after', 'other'].map((id) => [id, { id, status: 'succeeded', attempts: 1, outputs: [], inputs: ['plan/a/read', 'other'].includes(id) ? [input] : [] }])) } }

it('共享图恢复新旧元数据；传播子到父、依赖下游，不扩展兄弟；独立读者可独立恢复', async () => {
  const stores = await setup()
  await stores.runs.create(state('r'), snapshot)
  await writeFile(path.join(stores.taktDir, 'runs/r/engine.json'), JSON.stringify({ nodes: [
    { id: 'plan', needs: [], kind: 'planner', title: 'Plan' },
    { id: 'plan/a/read', needs: [], parent: 'plan', kind: 'agent', role: 'dev', harness: 'codex', title: 'Read' },
    { id: 'plan/a/sibling', needs: [], parent: 'plan' },
    { id: 'after', needs: ['plan'] }, { id: 'other', needs: [] },
  ] }))
  const graph = await loadRunGraph(stores, 'r')
  expect(graph.find((node) => node.id === 'plan/a/read')).toMatchObject({ kind: 'agent', role: 'dev', title: 'Read' })
  expect(graph.find((node) => node.id === 'after')).toMatchObject({ kind: 'script', needs: ['plan'] })
  const ids = await markArtifactEdited(stores, { ...input, version: 2 }, actor, 'new')
  expect(new Set(ids.map((node) => node.nodeId))).toEqual(new Set(['plan/a/read', 'plan', 'after', 'other']))
  expect((await stores.events.read('r')).filter((event) => event.type === 'artifact.edited')).toHaveLength(1)
  const fresh = new FsRunStore(stores.taktDir)
  const resumed = (await fresh.get('r'))!
  resumed.nodes.other!.attempts++
  resumed.nodes.other!.inputs = [{ ...input, version: 2 }]
  resumed.nodes.other!.status = 'succeeded'
  await fresh.save(resumed)
  expect((await fresh.get('r'))!.nodes.other!.status).toBe('succeeded')
  expect((await fresh.get('r'))!.nodes.plan!.status).toBe('stale')
  for (const id of ['plan', 'plan/a/read', 'after']) { resumed.nodes[id]!.attempts++; resumed.nodes[id]!.status = 'succeeded' }
  resumed.nodes['plan/a/read']!.inputs = [{ ...input, version: 2 }]
  await fresh.save(resumed)
  expect(Object.values((await fresh.get('r'))!.nodes).every((node) => node.status === 'succeeded')).toBe(true)
})

it('只对读取旧版本的相关运行记录一次修改，其他需求和同版本读者不受影响', async () => {
  const stores = await setup()
  const one = state('one'); const two = state('two'); const same = state('same'); const other = state('other')
  for (const node of Object.values(same.nodes)) if (node.inputs?.length) node.inputs = [{ ...input, version: 2 }]
  other.requirementId = 'REQ-2'
  for (const run of [one, two, same, other]) await stores.runs.create(run, snapshot)
  const changed = await markArtifactEdited(stores, { ...input, version: 2 }, actor, 'edit')
  expect(new Set(changed.map((node) => node.runId))).toEqual(new Set(['one', 'two']))
  for (const id of ['one', 'two']) expect((await stores.events.read(id)).filter((event) => event.type === 'artifact.edited')).toHaveLength(1)
  expect(await stores.events.read('same')).toEqual([])
  expect(await stores.events.read('other')).toEqual([])
  await expect(markArtifactEdited(stores, input, { type: 'system', id: 's' }, 'x')).rejects.toThrow('human')
  await expect(markArtifactEdited(stores, input, actor, ' ')).rejects.toThrow('原因')
})

it('串行读者 a→b 分别消费新版本即可推进，非读者下游新一代 skipped 可清除失效', async () => {
  const stores = await setup()
  const serial: WorkflowSnapshot = { ...snapshot, nodes: [
    { id: 'a', kind: 'script', title: 'a', needs: [] },
    { id: 'b', kind: 'script', title: 'b', needs: ['a'] },
    { id: 'c', kind: 'script', title: 'c', needs: ['b'] },
  ] }
  const original = state('serial')
  original.expansions = []
  original.nodes = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, {
    id, status: 'succeeded', attempts: 1, outputs: [], inputs: id === 'c' ? [] : [input],
  }]))
  await stores.runs.create(original, serial)
  await markArtifactEdited(stores, { ...input, version: 2 }, actor, 'edit')
  const resumed = (await stores.runs.get('serial'))!
  resumed.nodes.a!.attempts++
  resumed.nodes.a!.status = 'succeeded'
  resumed.nodes.a!.inputs = [{ ...input, version: 2 }]
  await stores.runs.save(resumed)
  expect((await stores.runs.get('serial'))!.nodes.a!.status).toBe('succeeded')
  expect((await stores.runs.get('serial'))!.nodes.b!.status).toBe('stale')
  resumed.nodes.b!.attempts++
  resumed.nodes.b!.status = 'succeeded'
  resumed.nodes.b!.inputs = [{ ...input, version: 2 }]
  resumed.nodes.c!.attempts++
  resumed.nodes.c!.status = 'skipped'
  await stores.runs.save(resumed)
  const readback = (await stores.runs.get('serial'))!
  expect(readback.nodes.b!.status).toBe('succeeded')
  expect(readback.nodes.c!.status).toBe('skipped')
})

it('嵌套 loop 内层 iteration 回到 1 时，单调的新 attempt 可消费新版本恢复', async () => {
  const stores = await setup()
  const original = state('nested')
  original.nodes['plan/a/read']!.attempts = 3
  original.nodes['plan/a/read']!.iteration = 2
  await stores.runs.create(original, snapshot)
  await markArtifactEdited(stores, { ...input, version: 2 }, actor, 'edit')
  const resumed = (await stores.runs.get('nested'))!
  const reader = resumed.nodes['plan/a/read']!
  reader.iteration = 1
  reader.attempts = 4
  reader.inputs = [{ ...input, version: 2 }]
  reader.status = 'succeeded'
  await stores.runs.save(resumed)
  expect((await stores.runs.get('nested'))!.nodes[reader.id]).toMatchObject({ status: 'succeeded', iteration: 1, attempts: 4 })
})

it('晚到 v2 编辑不能使已经消费 v3 的节点失效', async () => {
  const stores = await setup()
  const original = state('newer')
  for (const node of Object.values(original.nodes)) if (node.inputs?.length) node.inputs = [{ ...input, version: 3 }]
  await stores.runs.create(original, snapshot)
  expect(await markArtifactEdited(stores, { ...input, version: 2 }, actor, 'late edit')).toEqual([])
  expect(Object.values((await stores.runs.get('newer'))!.nodes).every((node) => node.status === 'succeeded')).toBe(true)
})


it('旧读者新一代重判为 skipped 且清空旧产出时，本节点及下游可恢复', async () => {
  const stores = await setup()
  await stores.runs.create(state('skip-reader'), snapshot)
  await markArtifactEdited(stores, { ...input, version: 2 }, actor, 'edit')
  const resumed = (await stores.runs.get('skip-reader'))!
  const reader = resumed.nodes['plan/a/read']!
  reader.attempts++
  reader.status = 'skipped'
  reader.inputs = []
  reader.outputs = []
  delete reader.result
  for (const id of ['plan', 'after']) { resumed.nodes[id]!.attempts++; resumed.nodes[id]!.status = 'succeeded' }
  await stores.runs.save(resumed)
  const readback = (await stores.runs.get('skip-reader'))!
  expect(readback.nodes[reader.id]!.status).toBe('skipped')
  expect(readback.nodes.plan!.status).toBe('succeeded')
  expect(readback.nodes.after!.status).toBe('succeeded')
  expect(readback.nodes.other!.status).toBe('stale')
})
