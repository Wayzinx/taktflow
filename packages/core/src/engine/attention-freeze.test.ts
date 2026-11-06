import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { human } from '../dsl.js'
import { initProject } from '../store/project.js'
import type { WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('人工待办冻结创建时的尝试次数和输入产物版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-attention-freeze-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '冻结' })
  await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'spec.md' }, content: 'v1', kind: 'input',
    author: { type: 'system', id: 'fixture' },
  })
  const workflow: WorkflowDefinition = {
    id: 'freeze', title: '', version: '1', stages: [],
    nodes: [human({ id: 'confirm', title: '确认', inputs: [{ path: 'spec.md' }], ask: '继续？', form: 'approve' })],
  }
  const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
    .start({ requirementId: requirement.id, workflow })
  expect(state.status).toBe('waiting_human')
  const [item] = await stores.attention.list({ pending: true })
  expect(item).toMatchObject({
    requestId: `${state.runId}:confirm`,
    attempt: 1,
    subjects: [{ workspace: requirement.id, path: 'spec.md', version: 1 }],
  })
})

it.each(['review', 'loop', 'judge'] as const)('M2 %s 的人工待办冻结版本，改版后原答复被拒绝', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'takt-m2-freeze-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: kind })
  const ref = { workspace: req.id, path: 'spec.md' }
  await stores.workspaces.writeArtifact({ ref, content: 'v1', kind: 'input', author: { type: 'system', id: 'test' } })
  const base = { id: 'confirm', title: '确认', inputs: [{ path: 'spec.md' }] }
  const nodes: import('../types.js').NodeDef[] = kind === 'review' ? [{ ...base, kind, target: ['spec.md'], author: { role: 'writer' }, reviewers: [{ role: 'reviewer' }], maxRounds: 1, onExhausted: 'human', humanSignoff: true }]
    : kind === 'loop' ? [{ ...base, kind, body: [], maxIterations: 1, until: () => false, onExhausted: 'human' }]
    : [{ id: 'test', kind: 'script', title: '', run: async () => ({ status: 'succeeded', data: { failures: [{ subject: 'TC-1' }] } }) }, { ...base, kind, needs: ['test'], target: 'test', role: 'reviewer', routes: { product_bug: 'human' } }]
  const mock: import('../types.js').HarnessAdapter = {
    id: 'mock', displayName: 'Mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }),
    run: async () => ({ ok: true, finalText: '', structured: kind === 'review' ? { verdict: 'approve', summary: '通过', issues: [] } : { verdicts: [{ subject: 'TC-1', category: 'product_bug', confidence: 1, rationale: '失败', evidence: ['spec.md'] }] } }),
  }
  const workflow: WorkflowDefinition = { id: 'm2', title: '', version: '1', stages: [], nodes }
  const engine = createEngine({ stores, knowledge: [], harnesses: { mock }, profiles: { writer: { role: 'writer', title: '', description: '', instructions: '', harness: { harness: 'mock' }, skills: [], writeScope: [] }, reviewer: { role: 'reviewer', title: '', description: '', instructions: '', harness: { harness: 'mock' }, skills: [], writeScope: [] } } })
  const state = await engine.start({ requirementId: req.id, workflow })
  expect(state.status).toBe('waiting_human')
  const [item] = await stores.attention.list({ pending: true })
  expect(item).toMatchObject({ attempt: 1, subjects: [{ ...ref, version: 1 }] })
  await stores.workspaces.writeArtifact({ ref, content: 'v2', kind: 'input', author: { type: 'system', id: 'test' } })
  await expect(stores.attention.answer(item!.requestId, { decision: 'approve', by: { type: 'human', id: 'reviewer' } })).rejects.toThrow('待办已过期')
  expect((await stores.attention.list({ pending: true }))).toHaveLength(1)
  expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
})
