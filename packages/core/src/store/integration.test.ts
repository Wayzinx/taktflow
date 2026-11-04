import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  FsInsights, buildRunGraph, initProject, openProject, snapshotWorkflow,
  type Actor, type RunState, type WorkflowDefinition,
} from '../index.js'

const roots: string[] = []
const actor: Actor = { type: 'system', id: 'integration' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('通过公共出口创建项目，重开后从文件还原事件、图、覆盖率与溯源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-store-integration-'))
  roots.push(root)
  const stores = await initProject(root, { name: '集成验证' })
  const requirement = await stores.workspaces.createRequirement({ title: '验收链路' })
  const workflow: WorkflowDefinition = {
    id: 'delivery', title: '交付', version: '1', stages: [{ id: 'test', title: '测试' }],
    nodes: [{
      id: 'loop', kind: 'loop', title: '研发测试', stage: 'test', maxIterations: 2,
      until: () => true,
      body: [{ id: 'run', kind: 'script', title: '执行用例', run: async () => undefined }],
    }],
  }
  const state: RunState = {
    runId: 'run-integration', requirementId: requirement.id,
    workflowId: workflow.id, workflowVersion: workflow.version,
    status: 'succeeded', startedAt: '2026-11-04T00:00:00.000Z',
    endedAt: '2026-11-04T00:01:00.000Z', args: {}, expansions: [],
    nodes: {
      loop: { id: 'loop', status: 'succeeded', attempts: 1, iteration: 1, outputs: [] },
      'loop/run': { id: 'loop/run', status: 'succeeded', attempts: 1, iteration: 1, outputs: [] },
    },
  }
  await stores.runs.create(state, snapshotWorkflow(workflow))
  const spec = await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'spec/spec.md' },
    content: '# 验收标准\n- AC-1: 可以完成交付\n- AC-2: 可以撤销\n', kind: 'spec', author: actor,
  })
  await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'cases/TC-ONE.json' },
    content: JSON.stringify({ id: 'TC-ONE', covers: ['AC-1'] }),
    kind: 'case', author: actor, derivedFrom: [spec],
    producedBy: { runId: state.runId, nodeId: 'loop/run' },
  })
  await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'evidence/summary.json' },
    content: JSON.stringify({ cases: [{ id: 'TC-ONE', status: 'passed' }] }),
    kind: 'evidence', author: actor,
  })
  await stores.events.append(state.runId, {
    type: 'node.started', actor, nodeId: 'loop/run', data: { attempt: 1, iteration: 1 },
  })
  await stores.events.append(state.runId, {
    type: 'harness.usage', actor, nodeId: 'loop/run', data: { inputTokens: 40, outputTokens: 10 },
  })
  await stores.events.append(state.runId, {
    type: 'node.finished', actor, nodeId: 'loop/run',
    data: { status: 'succeeded', outputs: [], result: { failures: [], total: 1 }, usage: { inputTokens: 40, outputTokens: 10 } },
  })
  await mkdir(join(root, 'src/nested'), { recursive: true })
  const reopened = await openProject(join(root, 'src/nested'))
  expect(reopened.projectDir).toBe(stores.projectDir)
  expect(await reopened.events.verify(state.runId)).toEqual({ ok: true })
  const insights = new FsInsights(reopened)
  const metrics = await insights.metrics(requirement.id)
  expect(metrics.runs).toBe(1)
  expect(metrics.firstPassRate).toBe(1)
  expect(metrics.usage).toMatchObject({ inputTokens: 40, outputTokens: 10 })
  expect(metrics.acCoverage).toEqual(expect.arrayContaining([
    expect.objectContaining({ ac: 'AC-1', cases: 1, passed: 1, failed: 0 }),
    expect.objectContaining({ ac: 'AC-2', cases: 0, passed: 0, failed: 0, status: 'uncovered' }),
  ]))
  const trace = await insights.traceGraph(requirement.id)
  expect(trace.edges.some((edge) => edge.rel === 'covers')).toBe(true)
  expect(trace.edges.some((edge) => edge.rel === 'derives')).toBe(true)
  expect(trace.edges.some((edge) => edge.rel === 'produced')).toBe(true)
  const nodeIds = new Set(trace.nodes.map((node) => node.id))
  expect(trace.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(true)
  const savedState = await reopened.runs.get(state.runId)
  const savedWorkflow = await reopened.runs.getWorkflow(state.runId)
  const graph = buildRunGraph(savedWorkflow!, savedState!)
  expect(graph.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'loop/run', parent: 'loop', status: 'succeeded' }),
  ]))
})
