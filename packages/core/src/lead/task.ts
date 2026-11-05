import type { AgentProfile, TaskSpec, WorkflowDefinition } from '../types.js'
import type { ProjectStores } from '../interfaces.js'
import { assertArtifactPath } from '../store/paths.js'
import { intersectWriteScopes } from '../engine/scope.js'

export function taskWorkflow(task: TaskSpec, stores: ProjectStores, profiles: Record<string, AgentProfile>): { workflow: WorkflowDefinition; profiles: Record<string, AgentProfile> } {
  const profile = Object.hasOwn(profiles, task.role) ? profiles[task.role] : undefined
  if (!profile || task.role === 'lead') throw new Error(`不可派发的角色：${task.role}`)
  if (!task.title?.trim() || !task.instructions?.trim()) throw new Error('任务必须有 title 和 instructions')
  if (task.repo && !stores.config.repos?.some((repo) => repo.id === task.repo)) throw new Error(`仓库不存在：${task.repo}`)
  for (const input of task.inputs ?? []) assertArtifactPath(input)
  for (const output of task.outputs ?? []) {
    assertArtifactPath(output.path)
    if (!['input', 'clarification', 'spec', 'design', 'contract', 'test-plan', 'case', 'task', 'script', 'code-change', 'evidence', 'verdict', 'review', 'report', 'decision', 'knowledge', 'other'].includes(output.kind)) throw new Error(`非法产物类型：${output.kind}`)
    if (output.path === 'lead-notes.md' || output.path.startsWith('reviews/')) throw new Error('任务不能覆盖 Lead 备忘或评审记录')
  }
  for (const pattern of task.writeScope ?? []) {
    if (!pattern || pattern.startsWith('/') || pattern.includes('\\') || pattern.split('/').includes('..')) throw new Error('writeScope 必须是空间内的相对路径')
  }
  const effective = intersectWriteScopes(profile.writeScope, task.writeScope)
  // 收窄角色本身，确保评审作者的修改也继承相同边界。
  const scopedProfiles = { ...profiles, [task.role]: { ...profile, writeScope: effective } }
  const workflow: WorkflowDefinition = { id: `task:${task.role}`, title: task.title, version: '1', stages: [], nodes: [{
    id: 'task', kind: 'agent', title: task.title, role: task.role, prompt: task.instructions,
    inputs: task.inputs?.map((path) => ({ path })), outputs: task.outputs, writeScope: effective, repo: task.repo,
  }] }
  if (task.review !== false) {
    const review = task.review ?? { reviewers: ['reviewer'], maxRounds: 3 }
    if (!review.reviewers.length || review.reviewers.some((role) => !Object.hasOwn(profiles, role) || role === task.role || role === 'lead')) throw new Error('评审者必须存在且独立于作者')
    if (!Number.isInteger(review.maxRounds) || review.maxRounds < 1) throw new Error('评审轮数必须为正整数')
    if (!task.repo && !task.outputs?.length) throw new Error('默认评审需要声明输出产物或目标仓库')
    workflow.nodes.push({ id: 'review', kind: 'review', title: `评审：${task.title}`, needs: ['task'],
      target: task.repo ? { code: { repo: task.repo } } : task.outputs!.map((output) => output.path),
      author: { role: task.role, prompt: task.instructions }, reviewers: review.reviewers.map((role) => ({ role })),
      maxRounds: review.maxRounds, onExhausted: 'human',
    })
  }
  return { workflow, profiles: scopedProfiles }
}
