import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject, snapshotWorkflow, type RunState, type WorkflowDefinition } from '@taktflow/core'
import { overview } from './read-model.js'
import { spaceSummary } from './space.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const workflow: WorkflowDefinition = { id: 'delivery', title: '交付', version: '1', stages: [{ id: 'dev', title: '研发' }],
  nodes: [{ id: 'build', kind: 'script', title: '构建', stage: 'dev', run: async () => undefined }] }

it('空间卡片的进行中 / 阻塞与总览同口径：按最近一次流水线运行推导，不看存下来的旧状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-space-summary-'))
  roots.push(root)
  const stores = await initProject(root, { name: '口径' })
  const run = async (requirementId: string, runId: string, status: RunState['status'], startedAt: string, workflowId = workflow.id) => stores.runs.create({
    runId, requirementId, workflowId, workflowVersion: '1', status, startedAt, args: {}, expansions: [],
    nodes: { build: { id: 'build', status: status === 'failed' ? 'failed' : status === 'succeeded' ? 'succeeded' : 'running', attempts: 1, outputs: [] } },
  }, snapshotWorkflow(workflow))
  const failed = await stores.workspaces.createRequirement({ title: '运行失败' })
  const running = await stores.workspaces.createRequirement({ title: '在跑' })
  await stores.workspaces.createRequirement({ title: '草稿' })
  await run(failed.id, 'run-1', 'failed', '2026-11-04T00:00:00.000Z')
  // Lead 派发的任务运行晚于失败的流水线运行，不改变需求状态
  await run(failed.id, 'run-2', 'succeeded', '2026-11-04T01:00:00.000Z', 'task:fix')
  await run(running.id, 'run-3', 'running', '2026-11-04T02:00:00.000Z')
  const [summary, project] = await Promise.all([spaceSummary(stores), overview(stores)])
  expect(project.totals).toMatchObject({ requirements: 3, active: 1, blocked: 1 })
  expect(summary).toMatchObject({ requirements: 3, active: project.totals.active, blocked: project.totals.blocked })
})
