import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContextSnapshot, RunState, WorkflowSnapshot } from '../types.js'
import { FsRunStore } from './fs-runs.js'

const runId = 'run-20261104-000001'

const state = (over: Partial<RunState> = {}): RunState => ({
  runId,
  workflowId: 'sdlc',
  workflowVersion: '1',
  requirementId: 'REQ-001',
  status: 'running',
  startedAt: '2026-11-04T01:00:00.000Z',
  args: { dryRun: false },
  nodes: {},
  expansions: [],
  ...over,
})

const workflow: WorkflowSnapshot = {
  id: 'sdlc',
  title: '默认流水线',
  version: '1',
  stages: [{ id: 'understand', title: '需求理解' }],
  nodes: [],
}

const snapshot = (nodeId: string, at: string): ContextSnapshot => ({
  nodeId,
  at,
  budgetTokens: 1000,
  totalTokens: 10,
  items: [],
})

describe('FsRunStore', () => {
  let root: string
  let taktDir: string
  let store: FsRunStore

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'takt-store-run-'))
    taktDir = path.join(root, '.takt')
    store = new FsRunStore(taktDir)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('create 保存运行状态和 workflow 快照，重复创建报错', async () => {
    await store.create(state(), workflow)
    expect(await store.get(runId)).toEqual(state())
    expect(await store.getWorkflow(runId)).toEqual(workflow)
    expect(await store.get('run-20261104-000404')).toBeUndefined()
    expect(await store.getWorkflow('run-20261104-000404')).toBeUndefined()
    await expect(store.create(state(), workflow)).rejects.toThrow('已存在')
  })

  it('save 覆盖状态，list 按需求过滤并按开始时间排序', async () => {
    await store.create(state(), workflow)
    await store.create(state({ runId: 'run-20261104-000002', startedAt: '2026-11-04T02:00:00.000Z' }), workflow)
    await store.create(
      state({ runId: 'run-20261104-000003', requirementId: 'REQ-002', startedAt: '2026-11-04T03:00:00.000Z' }),
      workflow,
    )
    expect((await store.list()).map((r) => r.runId)).toEqual([
      'run-20261104-000001',
      'run-20261104-000002',
      'run-20261104-000003',
    ])
    expect((await store.list({ requirementId: 'REQ-002' })).map((r) => r.runId)).toEqual(['run-20261104-000003'])

    await store.save(state({ status: 'succeeded', endedAt: '2026-11-04T01:10:00.000Z' }))
    expect((await store.get(runId))?.status).toBe('succeeded')
  })

  it('context 按节点累积快照与压缩记录，nodeId 里的 / 转成 __', async () => {
    await store.saveContext(runId, snapshot('write-spec', '2026-11-04T01:01:00.000Z'))
    await store.saveContext(runId, snapshot('write-spec', '2026-11-04T01:02:00.000Z'))
    await store.saveContext(runId, snapshot('planner/1/dev', '2026-11-04T01:03:00.000Z'))
    await store.saveCompaction(runId, {
      nodeId: 'write-spec',
      at: '2026-11-04T01:04:00.000Z',
      trigger: 'auto',
      beforeTokens: 900,
      afterTokens: 400,
      summary: '压掉历史',
      dropped: ['history'],
    })

    const context = await store.getContext(runId, 'write-spec')
    expect(context.snapshots.map((s) => s.at)).toEqual(['2026-11-04T01:01:00.000Z', '2026-11-04T01:02:00.000Z'])
    expect(context.compactions).toHaveLength(1)
    expect(context.compactions[0]?.summary).toBe('压掉历史')
    expect(existsSync(path.join(taktDir, 'runs', runId, 'context', 'planner__1__dev.json'))).toBe(true)
    expect((await store.getContext(runId, 'planner/1/dev')).snapshots).toHaveLength(1)
    expect(await store.getContext(runId, 'nobody')).toEqual({ snapshots: [], compactions: [] })
  })

  it('并发保存不同节点的上下文不会互相覆盖', async () => {
    const other = new FsRunStore(taktDir)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? store : other).saveContext(runId, snapshot(`node-${i}`, `2026-11-04T01:0${i}:00.000Z`)),
      ),
    )
    for (let i = 0; i < 10; i++) {
      expect((await store.getContext(runId, `node-${i}`)).snapshots).toHaveLength(1)
    }
  })

  it('拒绝非法 runId 和 nodeId', async () => {
    await expect(store.get('../escape')).rejects.toThrow('非法运行 ID')
    await expect(store.getContext(runId, '../escape')).rejects.toThrow('非法节点 ID')
    await expect(store.getContext(runId, 'a//b')).rejects.toThrow('非法节点 ID')
  })

  it('同一节点并发追加上下文与压缩记录不丢数据', async () => {
    const other = new FsRunStore(path.relative(process.cwd(), taktDir))
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? store : other).saveContext(runId, snapshot('planner/a/dev', `${i}`))))
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? store : other).saveCompaction(runId, {
      nodeId: 'planner/a/dev', at: `${i}`, trigger: 'auto', beforeTokens: 100, afterTokens: 50, summary: `${i}`, dropped: [],
    })))
    const context = await store.getContext(runId, 'planner/a/dev')
    expect(context.snapshots).toHaveLength(10)
    expect(context.compactions).toHaveLength(10)
  })

  it('节点 / 与 __ 编码碰撞时不会混入其它节点上下文', async () => {
    await Promise.all([
      store.saveContext(runId, snapshot('a/b', 'first')),
      store.saveContext(runId, snapshot('a__b', 'second')),
    ])
    expect((await store.getContext(runId, 'a/b')).snapshots.map((s) => s.at)).toEqual(['first'])
    expect((await store.getContext(runId, 'a__b')).snapshots.map((s) => s.at)).toEqual(['second'])
  })
  it('新实例普通更新、多次读取更新和交错的旧快照均保留外部字段', async () => {
    await store.create(state({ nodes: { a: { id: 'a', attempts: 1, status: 'running', outputs: [] } } }), workflow)
    const writer = new FsRunStore(taktDir)
    const cached = (await writer.get(runId))!
    const external = new FsRunStore(taktDir)
    const update = (await external.get(runId))!
    update.args.external = 'new'
    update.nodes.a!.error = 'external note'
    await external.save(update)
    cached.nodes.a!.result = { done: true }
    await writer.save(cached)
    const reread = (await writer.get(runId))!
    expect(reread.args.external).toBe('new')
    expect(reread.nodes.a).toMatchObject({ error: 'external note', result: { done: true } })
    reread.nodes.a!.error = 'acknowledged'
    await writer.save(reread)
    expect((await external.get(runId))!.nodes.a!.error).toBe('acknowledged')
    const again = (await writer.get(runId))!
    again.status = 'succeeded'
    await writer.save(again)
    expect((await store.get(runId))!.status).toBe('succeeded')
  })

  it('未知来源的旧克隆不能通过当前基线快捷分支回退已保存的新执行代次', async () => {
    const original = state({ nodes: { a: { id: 'a', status: 'succeeded', attempts: 1, iteration: 2, outputs: [], inputs: [{ workspace: 'REQ-001', path: 'spec.md', version: 1 }] } } })
    await store.create(original, workflow)
    const oldClone = structuredClone(original)
    const latest = (await store.get(runId))!
    latest.status = 'succeeded'
    latest.endedAt = '2026-11-04T23:00:00.000Z'
    latest.nodes.a!.attempts = 2
    latest.nodes.a!.iteration = 1
    latest.nodes.a!.inputs![0]!.version = 2
    await store.save(latest)
    await store.save(oldClone)
    const preserved = (await store.get(runId))!
    expect(preserved.nodes.a).toMatchObject({ attempts: 2, iteration: 1, inputs: [{ version: 2 }] })
    expect(preserved.status).toBe('succeeded')
    expect(preserved.endedAt).toBe('2026-11-04T23:00:00.000Z')
  })

})
