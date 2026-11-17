import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentProfile, TaskSpec } from '../types.js'
import { initProject } from '../store/project.js'
import { validateAction } from './schema.js'
import { taskWorkflow } from './task.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const profiles = Object.fromEntries(['author', 'reviewer'].map((role): [string, AgentProfile] => [role,
  { role, title: role, description: '', instructions: '', skills: [], writeScope: ['requirements/**'] }]))
const task: TaskSpec = { role: 'author', title: '编写产物', instructions: '依据输入编写', inputs: ['spec/prd.md', 'evidence/**'],
  outputs: [{ path: 'design.md', kind: 'design' }] }

async function stores() {
  const root = await mkdtemp(join(tmpdir(), 'takt-lead-task-')); roots.push(root)
  return initProject(root)
}

it('Lead 任务评审去重合并 inputs 与额外 references，默认评审也带 inputs', async () => {
  const project = await stores()
  const explicit = taskWorkflow({ ...task, review: { reviewers: ['reviewer'], maxRounds: 3, references: ['spec/prd.md', 'contract/api.json'] } }, project, profiles)
  expect(explicit.workflow.nodes[1]).toMatchObject({ kind: 'review', target: ['design.md'],
    references: ['spec/prd.md', 'evidence/**', 'contract/api.json'], maxRounds: 3 })
  expect(taskWorkflow(task, project, profiles).workflow.nodes[1]).toMatchObject({ references: task.inputs })
  expect(taskWorkflow({ ...task, review: false }, project, profiles).workflow.nodes).toHaveLength(1)
})

it.each(['../other.md', '/tmp/other.md', 'manifest.json', 'ref\\outside.md'])('额外参考材料必须通过产物路径校验：%s', async path => {
  const project = await stores()
  expect(() => taskWorkflow({ ...task, review: { reviewers: ['reviewer'], maxRounds: 3, references: [path] } }, project, profiles)).toThrow()
})

it('Lead 工具 schema 接受 references 并拒绝错误类型，保留 review:false', () => {
  const action = { type: 'dispatch_task', task: { ...task, review: { reviewers: ['reviewer'], maxRounds: 3, references: ['ref/**'] } } }
  expect(() => validateAction(action)).not.toThrow()
  expect(() => validateAction({ ...action, task: { ...task, review: false } })).not.toThrow()
  expect(() => validateAction({ ...action, task: { ...task, review: { ...action.task.review, references: [1] } } })).toThrow()
})
