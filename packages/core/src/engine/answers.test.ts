import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { answerOrRead, recordAnswerOnce } from './answers.js'
import { withAttentionStaleness } from '../insights/attention.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('旧待办回答时回退到节点输入版本，已有绑定不能被替换，重复回答只审计一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-bound-answer-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '审批' })).id
  const ref = await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path: 'spec.md' }, content: '1', kind: 'spec', author: { type: 'system', id: 'test' } })
  await stores.runs.create({ runId: 'run-answer', requirementId, workflowId: 'w', workflowVersion: '1', status: 'waiting_human', args: {}, expansions: [], startedAt: '',
    nodes: { human: { id: 'human', status: 'waiting_human', attempts: 1, inputs: [ref], outputs: [] } } }, { id: 'w', title: 'w', version: '1', nodes: [], stages: [] })
  const item = await stores.attention.create({ requestId: 'old', requirementId, runId: 'run-answer', nodeId: 'human', ask: '确认', form: 'approve' })
  const input = { decision: 'approve', by: { type: 'human' as const, id: 'owner' } }
  const answered = await answerOrRead(stores, item, input)
  expect(answered.boundTo).toEqual([ref])
  expect((await stores.attention.list())[0]?.boundTo).toEqual([ref])
  await recordAnswerOnce(stores, 'run-answer', answered)
  await recordAnswerOnce(stores, 'run-answer', await answerOrRead(stores, item, input))
  expect(await stores.events.read('run-answer', { types: ['human.answered'] })).toHaveLength(1)
  expect((await withAttentionStaleness(stores, [answered]))[0]?.stale).toBe(false)
  const next = await stores.workspaces.writeArtifact({ ref, content: '2', kind: 'spec', author: { type: 'system', id: 'test' } })
  const bound = await stores.attention.create({ ...item, requestId: 'bound', boundTo: [ref] })
  expect((await stores.attention.answer(bound.requestId, { ...input, boundTo: [next] })).boundTo).toEqual([ref])
  expect((await withAttentionStaleness(stores, [answered]))[0]?.stale).toBe(true)
  expect(answered.stale).toBeUndefined()
})
