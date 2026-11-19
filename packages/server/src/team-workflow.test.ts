import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, defineWorkflow, human, initProject, script, snapshotWorkflow, type NodeContext, type RunState } from '@taktflow/core'
import { parseWorkflowSource } from '@taktflow/workflow-source'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runTeamWorker } from './team-workflow.js'

const hub = vi.hoisted(() => ({ teamJobs: vi.fn(), teamNodes: vi.fn(), enqueueTeamJob: vi.fn(), cancelTeamJob: vi.fn() }))
vi.mock('./team-hub.js', () => hub)

type Job = { id: string; nodeId: string; harness: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; result?: string }
const worker = (id: string, harness = 'codex', online = true) => ({ id, harness, online })
const options = { prompt: 'Implement the PRD', harness: 'codex', pollMs: 5 }
let root: string
let ctx: NodeContext
let jobs: Job[]

async function fixture(runId: string, by?: NonNullable<RunState['origin']>['by']): Promise<NodeContext> {
  const stores = await initProject(root)
  const run: RunState = {
    runId, requirementId: 'REQ-1', workflowId: 'team-delivery', workflowVersion: '1', status: 'running',
    startedAt: new Date().toISOString(), nodes: {}, args: {}, expansions: [],
    origin: by && { kind: 'chat', messageId: 'message', by, title: 'Start workflow' },
  }
  await stores.runs.create(run, snapshotWorkflow({ id: 'team-delivery', title: 'Team delivery', version: '1', stages: [], nodes: [] }))
  return {
    runId, nodeId: 'plan/item/implement', requirementId: run.requirementId, projectDir: root,
    workspaceDir: stores.workspaces.dir(run.requirementId), args: { actorId: 'spoofed' },
    resultOf: () => undefined, readArtifact: async () => undefined, log: vi.fn(),
  }
}

beforeEach(async () => {
  vi.resetAllMocks()
  root = await mkdtemp(join(tmpdir(), 'takt-team-workflow-'))
  ctx = await fixture('run-real', { type: 'human', id: 'alice' })
  jobs = []
  hub.teamJobs.mockImplementation(async () => jobs.map(job => ({ ...job })))
  hub.teamNodes.mockResolvedValue([worker('node-a'), worker('node-b')])
  hub.enqueueTeamJob.mockImplementation(async (_stores, { id, nodeId, harness }) => {
    jobs.push({ id, nodeId, harness, status: 'succeeded', result: 'worker report' })
    return { id }
  })
  hub.cancelTeamJob.mockImplementation(async (_stores, id, reason) => {
    const job = jobs.find(job => job.id === id)
    if (job && (job.status === 'queued' || job.status === 'running')) Object.assign(job, { status: 'failed', result: reason })
  })
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('团队 Worker 流程步骤', () => {
  it('在同一空间中选兼容且最空闲的节点，并接住首次轮询前的成功回执', async () => {
    jobs.push({ id: 'unrelated', nodeId: 'node-a', harness: 'codex', status: 'running' })
    hub.teamNodes.mockResolvedValue([worker('node-a'), worker('node-b'), worker('node-c', 'codex', false), worker('node-d', 'claude')])
    const result = await runTeamWorker(ctx, options)
    const jobId = jobs.at(-1)!.id
    expect(result).toMatchObject({ status: 'succeeded', data: { jobId, nodeId: 'node-b', harness: 'codex', status: 'succeeded', result: 'worker report' } })
    expect(hub.enqueueTeamJob).toHaveBeenCalledWith(expect.objectContaining({ projectDir: root }), {
      id: jobId, nodeId: 'node-b', harness: 'codex', prompt: options.prompt, actorId: 'alice',
    })
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining(`jobId=${jobId} nodeId=node-b harness=codex: succeeded\nworker report`))
  })

  it('区分真实运行、节点与轮次，缺少人类来源时不用运行参数冒充', async () => {
    const otherRun = await fixture('run-other', { type: 'agent', role: 'lead', harness: 'codex' })
    for (const context of [ctx, { ...ctx, iteration: 1 }, { ...ctx, nodeId: 'another-node' }, otherRun]) {
      await runTeamWorker(context, { ...options, nodeId: 'node-b' })
    }
    expect(new Set(jobs.map(job => job.id)).size).toBe(4)
    expect(hub.enqueueTeamJob).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ actorId: 'workflow:team-delivery', nodeId: 'node-b' }))
  })

  it('沿用原目标与失败回执，不改派到新上线的机器，也不接管冲突目标', async () => {
    hub.enqueueTeamJob.mockImplementationOnce(async (_stores, { id, nodeId, harness }) => {
      jobs.push({ id, nodeId, harness, status: 'failed', result: 'tests failed on worker' })
      return { id }
    })
    const first = await runTeamWorker(ctx, { ...options, nodeId: 'node-a' })
    hub.teamNodes.mockResolvedValue([worker('node-a', 'codex', false), worker('node-b')])
    expect(await runTeamWorker(ctx, { ...options, prompt: 'Updated wording' })).toEqual(first)
    expect(first).toMatchObject({ status: 'failed', message: expect.stringContaining('请人工核查'), data: { result: 'tests failed on worker' } })
    expect(await runTeamWorker(ctx, { ...options, nodeId: 'node-b' })).toMatchObject({ status: 'failed', message: expect.stringContaining('目标冲突') })
    expect(hub.enqueueTeamJob).toHaveBeenCalledTimes(1)
    expect(hub.cancelTeamJob).not.toHaveBeenCalled()
  })

  it('固定机器离线时不派给备选；入队时掉线也不会改派', async () => {
    hub.teamNodes.mockResolvedValueOnce([worker('node-a', 'codex', false), worker('node-b')])
    expect(await runTeamWorker(ctx, { ...options, nodeId: 'node-a' })).toMatchObject({ status: 'blocked' })
    expect(hub.enqueueTeamJob).not.toHaveBeenCalled()
    hub.enqueueTeamJob.mockRejectedValueOnce(new Error('worker disconnected'))
    expect(await runTeamWorker(ctx, options)).toMatchObject({ status: 'failed', message: expect.stringContaining('worker disconnected') })
    expect(hub.enqueueTeamJob).toHaveBeenCalledTimes(1)
  })

  it('运行取消时结束已经认领的作业，即使取消发生在入队返回之前', async () => {
    const controller = new AbortController()
    hub.enqueueTeamJob.mockImplementationOnce(async (_stores, { id, nodeId, harness }) => {
      jobs.push({ id, nodeId, harness, status: 'running' })
      controller.abort()
      return { id }
    })
    const result = await runTeamWorker({ ...ctx, signal: controller.signal }, options)
    expect(result).toMatchObject({
      status: 'failed', data: { jobId: jobs[0]!.id, status: 'failed', reason: '运行已取消' },
    })
    expect(hub.cancelTeamJob).toHaveBeenCalledWith(expect.anything(), jobs[0]!.id, '运行已取消')
    hub.enqueueTeamJob.mockClear()
    await expect(runTeamWorker({ ...ctx, iteration: 2, signal: controller.signal }, options)).rejects.toMatchObject({ name: 'AbortError' })
    expect(hub.enqueueTeamJob).not.toHaveBeenCalled()
  })

  it('有界等待无人认领的作业；超时后取消，恢复不会重新入队', async () => {
    hub.enqueueTeamJob.mockImplementationOnce(async (_stores, { id, nodeId, harness }) => {
      jobs.push({ id, nodeId, harness, status: 'queued' })
      return { id }
    })
    const result = await runTeamWorker(ctx, { ...options, timeoutMs: 15 })
    expect(result).toMatchObject({ status: 'failed', data: { jobId: jobs[0]!.id, status: 'failed', reason: '等待 Worker 结果超时' } })
    expect(hub.cancelTeamJob).toHaveBeenCalledTimes(1)
    expect(await runTeamWorker(ctx, options)).toMatchObject({ status: 'failed', data: { jobId: jobs[0]!.id, status: 'failed' } })
    expect(hub.enqueueTeamJob).toHaveBeenCalledTimes(1)
  })

  it.each(['succeeded', 'failed'] as const)('Hub 回执 %s 控制实际引擎是否进入人工复核', async status => {
    const stores = await initProject(root)
    const req = await stores.workspaces.createRequirement({ title: 'Team delivery' })
    hub.enqueueTeamJob.mockImplementationOnce(async (_stores, { id, nodeId, harness }) => {
      jobs.push({ id, nodeId, harness, status, result: 'worker report' })
      return { id }
    })
    const workflow = defineWorkflow({ id: 'team-delivery', title: 'Team delivery', version: '1', stages: [], nodes: [
      script({ id: 'implement', title: 'Implement', run: ctx => runTeamWorker(ctx, options) }),
      human({ id: 'review', title: 'Review', form: 'approve', needs: ['implement'], ask: 'Check the work on the remote machine' }),
    ] })
    const run = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ workflow, requirementId: req.id })
    expect(run.nodes.implement).toMatchObject({ status, result: { jobId: jobs[0]!.id, result: 'worker report' }, outputs: [] })
    expect(run.status).toBe(status === 'succeeded' ? 'waiting_human' : 'failed')
    const pending = await stores.attention.list({ runId: run.runId, pending: true })
    expect(pending.map(item => item.nodeId)).toEqual(status === 'succeeded' ? ['review'] : [])
  })
})

it('示例可被团队流水线列表解析，且保留依赖 Worker 成功的人工批准节点', async () => {
  const source = await readFile(new URL('../../../examples/team-delivery/team-delivery.workflow.ts', import.meta.url), 'utf8')
  const { model, diagnostics } = parseWorkflowSource(source)
  expect(diagnostics).toEqual([])
  expect(model.meta.tiers).toEqual({ kind: 'literal', value: [] })
  expect(model.nodes.map(node => [node.id, node.kind])).toEqual([['implement', 'script'], ['review', 'human']])
  expect(model.nodes[1]?.props).toMatchObject({ needs: { kind: 'literal', value: ['implement'] }, form: { kind: 'literal', value: 'approve' } })
})
