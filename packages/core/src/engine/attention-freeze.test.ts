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
