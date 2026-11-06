import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { EventEmitter, getEventListeners } from 'node:events'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  initProject, snapshotWorkflow,
  type Actor, type ArtifactComment, type ArtifactEditResponse, type AttentionItem, type EventEnvelope,
  type EventStore, type HarnessInfo, type ModelInfo, type ProjectStores, type RunState, type WorkflowDefinition,
} from '@taktflow/core'
import { ApiError, createApiCore, type EventStream, type ReadOp, type WriteOp } from './api-core.js'
import { createServer } from './index.js'
import { stream, streamEvents } from './stream.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-api-core-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root, { name: 'api-core' })
  const actor: Actor = { type: 'system', id: 'fixture' }
  const requirement = await stores.workspaces.createRequirement({ title: '核心' })
  const spec = await stores.workspaces.writeArtifact({
    ref: { workspace: requirement.id, path: 'spec.md' },
    content: '# 规格\n- AC-1\n', kind: 'spec', author: actor,
  })
  const workflow: WorkflowDefinition = {
    id: 'wf', title: '流程', version: '1', stages: [{ id: 'dev', title: '研发' }],
    nodes: [{ id: 'work', kind: 'script', title: '工作', stage: 'dev', inputs: [{ path: 'spec.md' }], run: async () => undefined }],
  }
  const state: RunState = {
    runId: 'run-1', requirementId: requirement.id, workflowId: 'wf', workflowVersion: '1',
    status: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z',
    args: {}, expansions: [],
    nodes: {
      work: {
        id: 'work', status: 'succeeded', attempts: 1,
        inputs: [{ workspace: requirement.id, path: 'spec.md', version: spec.version }], outputs: [],
      },
    },
  }
  await stores.runs.create(state, snapshotWorkflow(workflow))
  for (const event of [
    { type: 'run.started' as const, data: { workflowId: 'wf', workflowVersion: '1', args: {} } },
    { type: 'node.started' as const, nodeId: 'work', data: { attempt: 1 } },
    { type: 'node.finished' as const, nodeId: 'work', data: { status: 'succeeded' as const, outputs: [] } },
    { type: 'run.finished' as const, data: { status: 'succeeded' as const } },
  ]) await stores.events.append('run-1', { ...event, actor })
  await stores.attention.create({
    requestId: 'att-1', runId: 'run-1', nodeId: 'work', requirementId: requirement.id, ask: '继续？', form: 'approve',
  })
  return { root, stores, requirementId: requirement.id, runId: 'run-1' }
}

const human: Actor = { type: 'human', id: 'alice' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 让出事件循环一轮，等待同步调用链和已排队的微任务落地；不用定时器制造等待。 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

it('每个读操作都返回与 HTTP 路由一致的数据', async () => {
  const { stores, requirementId, runId } = await fixture()
  const harnesses: HarnessInfo[] = [{ id: 'mock', displayName: 'Mock', source: 'builtin', available: true, capabilities: {}, roles: [] }]
  const models: ModelInfo[] = [{ alias: 'fast', provider: 'demo', protocol: 'openai-chat', id: 'fast', keyPresent: false }]
  const core = createApiCore({ catalog: { getHarnesses: async () => harnesses, getModels: async () => models } })

  expect(await core.read(stores, 'project', {})).toMatchObject({ name: 'api-core', totals: { requirements: 1, runs: 1 } })
  expect(await core.read(stores, 'requirements', {})).toHaveLength(1)
  expect(await core.read(stores, 'requirement', { id: requirementId })).toMatchObject({
    id: requirementId, artifacts: [expect.objectContaining({ path: 'spec.md' })], runs: [expect.objectContaining({ runId })],
  })
  expect(await core.read(stores, 'artifacts', { id: requirementId })).toEqual([expect.objectContaining({ path: 'spec.md' })])
  expect(await core.read(stores, 'artifact', { id: requirementId, path: 'spec.md', version: '1' })).toMatchObject({
    path: 'spec.md', version: 1, encoding: 'utf8', content: expect.stringContaining('AC-1'),
  })
  expect(await core.read(stores, 'comments', { id: requirementId, path: 'spec.md' })).toEqual([])
  expect(await core.read(stores, 'trace', { id: requirementId })).toMatchObject({ nodes: expect.any(Array), edges: expect.any(Array) })
  expect(await core.read(stores, 'metrics', { id: requirementId })).toMatchObject({ requirementId, runs: 1 })
  expect(await core.read(stores, 'runs', { requirement: requirementId })).toEqual([expect.objectContaining({ runId })])
  expect(await core.read(stores, 'run', { runId })).toMatchObject({
    run: { runId }, workflow: { id: 'wf' }, graph: { nodes: [expect.objectContaining({ id: 'work' })] },
  })
  expect(await core.read(stores, 'events', { runId, after: '1', node: 'work' })).toEqual([
    expect.objectContaining({ seq: 2 }), expect.objectContaining({ seq: 3 }),
  ])
  expect(await core.read(stores, 'node', { runId, nodeId: 'work' })).toMatchObject({ state: { id: 'work' }, kind: 'script' })
  expect(await core.read(stores, 'audit', { runId })).toEqual({ ok: true })
  expect(await core.read(stores, 'attention', { pending: '1' })).toEqual([expect.objectContaining({ requestId: 'att-1' })])
  expect(await core.read(stores, 'harnesses', {})).toEqual(harnesses)
  expect(await core.read(stores, 'models', {})).toEqual(models)
})

it('每个读操作在参数非法或实体缺失时返回错误', async () => {
  const { stores, requirementId } = await fixture()
  const core = createApiCore()
  const broken: ProjectStores = {
    ...stores,
    workspaces: { ...stores.workspaces, listRequirements: async () => { throw new Error('存储损坏') } },
  }
  await expect(core.read(broken, 'project', {})).rejects.toThrow('存储损坏')
  await expect(core.read(broken, 'requirements', {})).rejects.toThrow('存储损坏')
  await expect(core.read(stores, 'requirement', { id: 'REQ-404' })).rejects.toMatchObject({ status: 404 })
  await expect(core.read(stores, 'artifacts', { id: 'REQ-404' })).rejects.toMatchObject({ status: 404 })
  await expect(core.read(stores, 'artifact', { id: requirementId })).rejects.toMatchObject({ status: 400 })
  await expect(core.read(stores, 'artifact', { id: requirementId, path: 'spec.md', version: '2' })).rejects.toMatchObject({ status: 404 })
  await expect(core.read(stores, 'comments', { id: requirementId, path: '../secret' })).rejects.toMatchObject({ status: 400 })
  await expect(core.read(stores, 'trace', { id: 'REQ-404' })).rejects.toMatchObject({ status: 404 })
  await expect(core.read(stores, 'metrics', { id: 'REQ-404' })).rejects.toMatchObject({ status: 404 })
  await expect(core.read(stores, 'runs', { requirement: '../bad' })).rejects.toMatchObject({ status: 400 })
  await expect(core.read(stores, 'run', { runId: 'run-404' })).rejects.toMatchObject({ status: 404 })
  await expect(core.read(stores, 'events', { runId: 'run-1', after: '-1' })).rejects.toMatchObject({ status: 400 })
  await expect(core.read(stores, 'node', { runId: 'run-1', nodeId: 'absent' })).rejects.toMatchObject({ status: 404 })
  await expect(core.read(stores, 'audit', { runId: 'run-404' })).rejects.toMatchObject({ status: 404 })
  await expect(core.read(stores, 'attention', { pending: '2' })).rejects.toMatchObject({ status: 400 })
  await expect(core.read(stores, 'harnesses', {})).rejects.toMatchObject({ status: 501 })
  await expect(core.read(stores, 'models', {})).rejects.toMatchObject({ status: 501 })
})

it('可选参数为 undefined 时视为未提供，空字符串仍然报错', async () => {
  const { stores, requirementId, runId } = await fixture()
  const core = createApiCore()
  expect(await core.read(stores, 'comments', { id: requirementId, path: undefined })).toEqual([])
  expect(await core.read(stores, 'runs', { requirement: undefined })).toHaveLength(1)
  expect(await core.read(stores, 'events', { runId, node: undefined })).toHaveLength(4)
  await expect(core.read(stores, 'comments', { id: requirementId, path: '' })).rejects.toMatchObject({ status: 400 })
  await expect(core.read(stores, 'runs', { requirement: '' })).rejects.toMatchObject({ status: 400 })
  await expect(core.read(stores, 'events', { runId, node: '' })).rejects.toMatchObject({ status: 400 })
})

it('写操作保持产物 stale、评论与待办答复语义', async () => {
  const { stores, requirementId } = await fixture()
  const answered: AttentionItem[] = []
  const core = createApiCore({ onAnswer: (item) => { answered.push(item) } })

  const edit = await core.write(
    stores, 'artifact.edit', { id: requirementId, path: 'spec.md' },
    { content: '# 规格 v2\n- AC-1\n', reason: '补充' }, human,
  ) as ArtifactEditResponse
  expect(edit).toEqual({ version: 2, staleNodes: [{ runId: 'run-1', nodeId: 'work' }] })

  const comment = await core.write(
    stores, 'comment.add', { id: requirementId },
    { path: 'spec.md', version: 2, body: '这里补一条' }, human,
  ) as ArtifactComment
  expect(comment).toMatchObject({ path: 'spec.md', version: 2, body: '这里补一条', author: human })

  const item = await core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human) as AttentionItem
  expect(item).toMatchObject({ requestId: 'att-1', decision: 'approve', answeredBy: human })
  expect(answered).toHaveLength(1)
})

it('写操作在参数非法或实体缺失时返回错误', async () => {
  const { stores, requirementId } = await fixture()
  const core = createApiCore()
  await expect(core.write(stores, 'artifact.edit', { id: requirementId, path: 'spec.md' }, { content: 'x' }, human)).rejects.toMatchObject({ status: 400 })
  await expect(core.write(stores, 'artifact.edit', { id: requirementId }, { content: 'x', reason: 'y' }, human)).rejects.toMatchObject({ status: 400 })
  await expect(core.write(stores, 'artifact.edit', { id: 'REQ-404', path: 'spec.md' }, { content: 'x', reason: 'y' }, human)).rejects.toMatchObject({ status: 404 })
  await expect(core.write(stores, 'comment.add', { id: requirementId }, { path: 'spec.md', body: 'x' }, human)).rejects.toMatchObject({ status: 400 })
  await expect(core.write(stores, 'comment.add', { id: requirementId }, { version: 1, body: 'x' }, human)).rejects.toMatchObject({ status: 400 })
  await expect(core.write(stores, 'comment.add', { id: requirementId }, { path: 'spec.md', version: 2, body: 'x' }, human)).rejects.toMatchObject({ status: 404 })
  await expect(core.write(stores, 'comment.add', { id: requirementId }, { path: 'spec.md', version: 1 }, human)).rejects.toMatchObject({ status: 400 })
  await expect(core.write(stores, 'attention.answer', { requestId: 'att-1' }, {}, human)).rejects.toMatchObject({ status: 400 })
  await expect(core.write(stores, 'attention.answer', { requestId: 'absent' }, { answer: 'x' }, human)).rejects.toMatchObject({ status: 404 })
  await expect(core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human)).resolves.toMatchObject({ answeredAt: expect.any(String) })
  await expect(core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human)).rejects.toMatchObject({ status: 409, message: '待办已处理' })
})

it('未知读写操作不会被静默分派', async () => {
  const { stores } = await fixture()
  const core = createApiCore()
  await expect(core.read(stores, 'unknown' as ReadOp, {})).rejects.toBeInstanceOf(ApiError)
  await expect(core.read(stores, 'unknown' as ReadOp, {})).rejects.toMatchObject({ status: 400 })
  await expect(core.write(stores, 'unknown' as WriteOp, {}, {}, human)).rejects.toBeInstanceOf(ApiError)
  await expect(core.write(stores, 'unknown' as WriteOp, {}, {}, human)).rejects.toMatchObject({ status: 400 })
})

it('catalog 独立回调优先于兼容回调', async () => {
  const { stores } = await fixture()
  const harnesses: HarnessInfo[] = [{ id: 'h', displayName: 'H', source: 'plugin', available: true, capabilities: {}, roles: [] }]
  const models: ModelInfo[] = [{ alias: 'm', provider: 'p', protocol: 'openai-chat', id: 'm', keyPresent: false }]
  const getHarnesses = vi.fn(async () => harnesses)
  const getModels = vi.fn(async () => models)
  const getCatalog = vi.fn(async () => ({ harnesses: [], models: [] }))
  const core = createApiCore({ catalog: { getHarnesses, getModels, getCatalog } })
  expect(await core.read(stores, 'harnesses', {})).toEqual(harnesses)
  expect(await core.read(stores, 'models', {})).toEqual(models)
  expect(getHarnesses).toHaveBeenCalledOnce()
  expect(getModels).toHaveBeenCalledOnce()
  expect(getCatalog).not.toHaveBeenCalled()

  const fallback = createApiCore({ catalog: { getCatalog } })
  expect(await fallback.read(stores, 'harnesses', {})).toEqual([])
  expect(await fallback.read(stores, 'models', {})).toEqual([])
  expect(getCatalog).toHaveBeenCalledTimes(2)
})

it('写操作与 onAnswer 都在租约钩子内执行', async () => {
  const { stores, requirementId } = await fixture()
  const calls: string[] = []
  let inside = false
  const core = createApiCore({
    withWriteLease: async (_stores, fn) => {
      calls.push('lease')
      inside = true
      try { return await fn() } finally { inside = false; calls.push('release') }
    },
    onAnswer: () => { expect(inside).toBe(true); calls.push('answer') },
  })
  await core.write(stores, 'artifact.edit', { id: requirementId, path: 'spec.md' }, { content: 'v2', reason: '修改' }, human)
  expect(calls).toEqual(['lease', 'release'])
  await core.write(stores, 'comment.add', { id: requirementId }, { path: 'spec.md', version: 2, body: '评论' }, human)
  expect(calls).toEqual(['lease', 'release', 'lease', 'release'])
  await core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human)
  expect(calls).toEqual(['lease', 'release', 'lease', 'release', 'lease', 'answer', 'release'])
})

it('租约被占用时所有写操作返回 409 且没有副作用', async () => {
  const { stores, requirementId } = await fixture()
  const deny = async () => { throw Object.assign(new Error('空间正被 dsh 使用'), { code: 'TAKT_LEASE_HELD' }) }
  const core = createApiCore({ withWriteLease: deny })
  const writes: Array<Promise<unknown>> = [
    core.write(stores, 'artifact.edit', { id: requirementId, path: 'spec.md' }, { content: 'v2', reason: '修改' }, human),
    core.write(stores, 'comment.add', { id: requirementId }, { path: 'spec.md', version: 1, body: '评论' }, human),
    core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human),
  ]
  for (const write of writes) await expect(write).rejects.toMatchObject({ status: 409, message: '空间正被 dsh 使用' })
  expect((await stores.workspaces.listArtifacts(requirementId))[0]!.versions).toHaveLength(1)
  expect(await stores.workspaces.listComments(requirementId)).toEqual([])
  expect((await stores.attention.list()).find((item) => item.requestId === 'att-1')!.answeredAt).toBeUndefined()
})

it('HTTP 写入口在租约拒绝时返回 409 且不产生副作用', async () => {
  const { root, stores, requirementId } = await fixture()
  const deny = async () => { throw Object.assign(new Error('空间正被 dsh 使用'), { code: 'TAKT_LEASE_HELD' }) }
  const server = await createServer({ projectDir: root, port: 0, withWriteLease: deny })
  cleanups.push(() => server.close())
  const responses = await Promise.all([
    fetch(`${server.url}/api/requirements/${requirementId}/artifact?path=spec.md`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'v2', reason: '修改' }) }),
    fetch(`${server.url}/api/requirements/${requirementId}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'spec.md', version: 1, body: '评论' }) }),
    fetch(`${server.url}/api/attention/att-1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) }),
  ])
  for (const response of responses) {
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: '空间正被 dsh 使用' })
  }
  expect((await stores.workspaces.listArtifacts(requirementId))[0]!.versions).toHaveLength(1)
  expect(await stores.workspaces.listComments(requirementId)).toEqual([])
  expect((await stores.attention.list()).find((item) => item.requestId === 'att-1')!.answeredAt).toBeUndefined()
})

it('租约钩子的非 TAKT_LEASE_HELD 错误仍被 HTTP 隐藏为 500', async () => {
  const { root, requirementId } = await fixture()
  const server = await createServer({
    projectDir: root, port: 0,
    withWriteLease: async () => { throw new Error('内部细节不能泄露') },
  })
  cleanups.push(() => server.close())
  const response = await fetch(`${server.url}/api/requirements/${requirementId}/artifact?path=spec.md`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'v2', reason: '修改' }),
  })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: '服务器内部错误' })
})

it('普通对象形式的租约错误保留 message 并映射为 409', async () => {
  const { stores, requirementId } = await fixture()
  const core = createApiCore({
    withWriteLease: async () => { throw { code: 'TAKT_LEASE_HELD', message: '空间正被 dsh 使用' } },
  })
  await expect(core.write(stores, 'artifact.edit', { id: requirementId, path: 'spec.md' }, { content: 'v2', reason: '修改' }, human))
    .rejects.toMatchObject({ status: 409, message: '空间正被 dsh 使用' })
  expect((await stores.workspaces.listArtifacts(requirementId))[0]!.versions).toHaveLength(1)
})

it('HTTP 写入口把普通对象租约错误映射为 409 原文', async () => {
  const { root, requirementId } = await fixture()
  const server = await createServer({
    projectDir: root, port: 0,
    withWriteLease: async () => { throw { code: 'TAKT_LEASE_HELD', message: '空间正被 dsh 使用' } },
  })
  cleanups.push(() => server.close())
  const response = await fetch(`${server.url}/api/requirements/${requirementId}/artifact?path=spec.md`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'v2', reason: '修改' }),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: '空间正被 dsh 使用' })
})

it('租约钩子失败时不会产生写入或 onAnswer 副作用', async () => {
  const { stores, requirementId } = await fixture()
  const answered = vi.fn()
  const core = createApiCore({
    withWriteLease: async () => { throw new Error('租约失败') },
    onAnswer: answered,
  })
  await expect(core.write(stores, 'artifact.edit', { id: requirementId, path: 'spec.md' }, { content: 'v2', reason: '修改' }, human)).rejects.toThrow('租约失败')
  await expect(core.write(stores, 'comment.add', { id: requirementId }, { path: 'spec.md', version: 1, body: '评论' }, human)).rejects.toThrow('租约失败')
  await expect(core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human)).rejects.toThrow('租约失败')
  expect(answered).not.toHaveBeenCalled()
  expect((await stores.workspaces.listArtifacts(requirementId))[0]!.versions).toHaveLength(1)
  expect(await stores.workspaces.listComments(requirementId)).toEqual([])
  expect((await stores.attention.list()).find((item) => item.requestId === 'att-1')!.answeredAt).toBeUndefined()
})

it('onAnswer 抛错会释放租约，重试不会重复回调', async () => {
  const { stores } = await fixture()
  const calls: string[] = []
  const answer = vi.fn(async () => {
    calls.push('answer')
    throw new Error('回调失败')
  })
  const core = createApiCore({
    withWriteLease: async (_stores, fn) => {
      calls.push('lease')
      try { return await fn() } finally { calls.push('release') }
    },
    onAnswer: answer,
  })
  await expect(core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human)).rejects.toThrow('回调失败')
  expect(calls).toEqual(['lease', 'answer', 'release'])
  expect((await stores.attention.list()).find((item) => item.requestId === 'att-1')!.answeredAt).toBeTruthy()
  await expect(core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human)).rejects.toMatchObject({ status: 409, message: '待办已处理' })
  expect(calls).toEqual(['lease', 'answer', 'release', 'lease', 'release'])
  expect(answer).toHaveBeenCalledOnce()
})

it('onAnswer 在 serialize 之外等待，不阻塞其他写入', async () => {
  const { stores, requirementId } = await fixture()
  const gate = deferred<undefined>()
  const entered = deferred<undefined>()
  const core = createApiCore({
    onAnswer: () => { entered.resolve(undefined); return gate.promise },
  })
  const answering = core.write(stores, 'attention.answer', { requestId: 'att-1' }, { decision: 'approve' }, human)
  await entered.promise
  // 回答已落盘、onAnswer 挂起；若仍在 serialize 锁内，这次编辑会一直等锁。
  const edit = await core.write(stores, 'artifact.edit', { id: requirementId, path: 'spec.md' }, { content: 'v2', reason: '并发编辑' }, human)
  expect(edit).toMatchObject({ version: 2 })
  gate.resolve(undefined)
  await expect(answering).resolves.toMatchObject({ requestId: 'att-1' })
})

it('events 回放排序去重、推送实时事件，abort 后结束并释放订阅', async () => {
  const { stores, runId } = await fixture()
  let receive: ((event: EventEnvelope) => void) | undefined
  const stop = vi.fn()
  const event = (seq: number) => ({ seq, runId, type: 'log' } as EventEnvelope)
  const events = {
    subscribe: (_runId: string, handler: (value: EventEnvelope) => void) => { receive = handler; return stop },
    read: async () => { receive!(event(2)); receive!(event(3)); return [event(3), event(1), event(2)] },
  } as unknown as EventStore
  const controller = new AbortController()
  const stream = createApiCore().events({ ...stores, events }, runId, 0, controller.signal) as EventStream
  const iterator = stream[Symbol.asyncIterator]()
  await stream.ready
  expect((await iterator.next()).value!.seq).toBe(1)
  expect((await iterator.next()).value!.seq).toBe(2)
  expect((await iterator.next()).value!.seq).toBe(3)
  const pending = iterator.next()
  receive!(event(4))
  expect((await pending).value!.seq).toBe(4)
  controller.abort()
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
  expect(stop).toHaveBeenCalledOnce()
})

it('历史读取期间 abort 会结束迭代并取消订阅', async () => {
  const { stores, runId } = await fixture()
  const stop = vi.fn()
  let resolveRead: (events: EventEnvelope[]) => void = () => {}
  const read = vi.fn(() => new Promise<EventEnvelope[]>((resolve) => { resolveRead = resolve }))
  const events = { subscribe: () => stop, read } as unknown as EventStore
  const controller = new AbortController()
  const stream = createApiCore().events({ ...stores, events }, runId, 0, controller.signal) as EventStream
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  controller.abort()
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
  expect(stop).toHaveBeenCalledOnce()
  resolveRead([])
})

it('历史读取期间 return 迭代器也会结束等待', async () => {
  const { stores, runId } = await fixture()
  const stop = vi.fn()
  let resolveRead: (events: EventEnvelope[]) => void = () => {}
  const read = vi.fn(() => new Promise<EventEnvelope[]>((resolve) => { resolveRead = resolve }))
  const events = { subscribe: () => stop, read } as unknown as EventStore
  const stream = createApiCore().events({ ...stores, events }, runId, 0, new AbortController().signal) as EventStream
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  await iterator.return!()
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
  expect(stop).toHaveBeenCalledOnce()
  resolveRead([])
})

it('预中止的 signal 不订阅也不读历史', async () => {
  const { stores, runId } = await fixture()
  const subscribe = vi.fn()
  const read = vi.fn(async () => [])
  const controller = new AbortController()
  controller.abort()
  const stream = createApiCore().events({ ...stores, events: { subscribe, read } as unknown as EventStore }, runId, 0, controller.signal)
  expect(await stream[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
  expect(subscribe).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('events 校验运行与游标，历史读取失败会清理订阅', async () => {
  const { stores, runId } = await fixture()
  const core = createApiCore()
  await expect(core.events(stores, 'run-404', 0, new AbortController().signal)[Symbol.asyncIterator]().next())
    .rejects.toMatchObject({ status: 404 })
  await expect(core.events(stores, runId, 1.5, new AbortController().signal)[Symbol.asyncIterator]().next())
    .rejects.toMatchObject({ status: 400, message: 'after 不合法' })
  const stop = vi.fn()
  const events = { subscribe: () => stop, read: async () => { throw new Error('读失败') } } as unknown as EventStore
  const stream = core.events({ ...stores, events }, runId, 0, new AbortController().signal) as EventStream
  await expect(stream.ready).rejects.toThrow('读失败')
  expect(stop).toHaveBeenCalledOnce()
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('读失败')
})

it('启动失败后移除 abort 监听并清理订阅', async () => {
  const { stores, runId } = await fixture()
  const core = createApiCore()

  const missing = new AbortController()
  const missingEvents = { subscribe: vi.fn(), read: vi.fn(async () => []) } as unknown as EventStore
  const missingStores = {
    ...stores,
    runs: { ...stores.runs, get: async () => undefined },
    events: missingEvents,
  } as ProjectStores
  const missingStream = core.events(missingStores, 'run-missing', 0, missing.signal) as EventStream
  const missingIterator = missingStream[Symbol.asyncIterator]()
  const first = missingIterator.next()
  const second = missingIterator.next()
  await expect(first).rejects.toMatchObject({ status: 404 })
  await expect(second).rejects.toMatchObject({ status: 404 })
  expect(getEventListeners(missing.signal, 'abort')).toHaveLength(0)
  expect(missingEvents.subscribe).not.toHaveBeenCalled()
  expect(missingEvents.read).not.toHaveBeenCalled()
  await expect(missingIterator.return!()).resolves.toEqual({ done: true, value: undefined })
  missing.abort()

  const invalidCursor = new AbortController()
  await expect(core.events(stores, runId, 1.5, invalidCursor.signal)[Symbol.asyncIterator]().next())
    .rejects.toMatchObject({ status: 400, message: 'after 不合法' })
  expect(getEventListeners(invalidCursor.signal, 'abort')).toHaveLength(0)

  const subscribeFailure = new AbortController()
  const throwing = {
    subscribe: () => { throw new Error('订阅失败') },
    read: vi.fn(async () => []),
  } as unknown as EventStore
  await expect(core.events({ ...stores, events: throwing }, runId, 0, subscribeFailure.signal)[Symbol.asyncIterator]().next())
    .rejects.toThrow('订阅失败')
  expect(getEventListeners(subscribeFailure.signal, 'abort')).toHaveLength(0)
  expect(throwing.read).not.toHaveBeenCalled()

  const readFailure = new AbortController()
  const stop = vi.fn()
  const failing = { subscribe: () => stop, read: async () => { throw new Error('读失败') } } as unknown as EventStore
  await expect(core.events({ ...stores, events: failing }, runId, 0, readFailure.signal)[Symbol.asyncIterator]().next())
    .rejects.toThrow('读失败')
  expect(getEventListeners(readFailure.signal, 'abort')).toHaveLength(0)
  expect(stop).toHaveBeenCalledOnce()
})

it('真实事件存储的订阅轮询定时器在 abort 后清理', async () => {
  const { stores, runId } = await fixture()
  vi.useFakeTimers()
  try {
    const controller = new AbortController()
    const stream = createApiCore().events(stores, runId, 0, controller.signal) as EventStream
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await stream.ready
    expect((await pending).value!.seq).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  } finally {
    vi.useRealTimers()
  }
})

it('提前 return 迭代器会释放订阅', async () => {
  const { stores, runId } = await fixture()
  const stop = vi.fn()
  const events = { subscribe: () => stop, read: async () => [] } as unknown as EventStore
  const stream = createApiCore().events({ ...stores, events }, runId, 0, new AbortController().signal) as EventStream
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  await stream.ready
  await iterator.return!()
  expect(stop).toHaveBeenCalledOnce()
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
})

it('等待实时事件时 return 会结束迭代并释放订阅', async () => {
  const { stores, runId } = await fixture()
  const stop = vi.fn()
  const events = { subscribe: () => stop, read: async () => [] } as unknown as EventStore
  const stream = createApiCore().events({ ...stores, events }, runId, 0, new AbortController().signal) as EventStream
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  await stream.ready
  await iterator.return!()
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
  expect(stop).toHaveBeenCalledOnce()
})

it('运行校验期间 abort 会立即结束等待且不订阅', async () => {
  const { stores, runId } = await fixture()
  const gate = deferred<RunState | undefined>()
  const get = vi.fn(() => gate.promise)
  const subscribe = vi.fn()
  const read = vi.fn(async () => [])
  const broken = {
    ...stores,
    runs: { ...stores.runs, get },
    events: { subscribe, read } as unknown as EventStore,
  } as ProjectStores
  const controller = new AbortController()
  const stream = createApiCore().events(broken, runId, 0, controller.signal) as EventStream
  const pending = stream[Symbol.asyncIterator]().next()
  expect(get).toHaveBeenCalledOnce()
  controller.abort()
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
  await expect(stream.ready).resolves.toBeUndefined()
  gate.resolve(undefined)
  await tick()
  expect(subscribe).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('运行校验期间 return 会立即结束等待且不订阅', async () => {
  const { stores, runId } = await fixture()
  const gate = deferred<RunState | undefined>()
  const get = vi.fn(() => gate.promise)
  const subscribe = vi.fn()
  const read = vi.fn(async () => [])
  const broken = {
    ...stores,
    runs: { ...stores.runs, get },
    events: { subscribe, read } as unknown as EventStore,
  } as ProjectStores
  const stream = createApiCore().events(broken, runId, 0, new AbortController().signal) as EventStream
  const iterator = stream[Symbol.asyncIterator]()
  const pending = iterator.next()
  expect(get).toHaveBeenCalledOnce()
  await iterator.return!()
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
  gate.resolve(undefined)
  await tick()
  expect(subscribe).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('未开始迭代就 return 不会订阅或读历史', async () => {
  const { stores, runId } = await fixture()
  const subscribe = vi.fn()
  const read = vi.fn(async () => [])
  const stream = createApiCore().events({ ...stores, events: { subscribe, read } as unknown as EventStore }, runId, 0, new AbortController().signal) as EventStream
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.return!()
  await stream.ready
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
  expect(subscribe).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('HTTP 查询参数取首值，路径参数优先于同名查询参数', async () => {
  const { root, requirementId, runId } = await fixture()
  const server = await createServer({ projectDir: root, port: 0 })
  cleanups.push(() => server.close())
  const events = await fetch(`${server.url}/api/runs/${runId}/events?runId=run-404&after=1&after=3`)
  expect(events.status).toBe(200)
  expect(((await events.json()) as EventEnvelope[]).map((event) => event.seq)).toEqual([2, 3, 4])
  const artifact = await fetch(`${server.url}/api/requirements/${requirementId}/artifact?path=spec.md&path=missing.md`)
  expect(artifact.status).toBe(200)
  expect((await artifact.json()) as { path: string }).toMatchObject({ path: 'spec.md' })
})

it('HTTP 写路由先校验需求与产物路径，再解析请求体', async () => {
  const { root, requirementId } = await fixture()
  const server = await createServer({ projectDir: root, port: 0 })
  cleanups.push(() => server.close())
  const missingRequirement = await fetch(`${server.url}/api/requirements/REQ-404/artifact?path=spec.md`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{' })
  expect(missingRequirement.status).toBe(404)
  const missingPath = await fetch(`${server.url}/api/requirements/${requirementId}/artifact`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{' })
  expect(missingPath.status).toBe(400)
  expect(await missingPath.json()).toEqual({ error: '必须提供字符串路径或 ID' })
  const missingCommentRequirement = await fetch(`${server.url}/api/requirements/REQ-404/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
  expect(missingCommentRequirement.status).toBe(404)
})

it('SSE 用 after 覆盖 Last-Event-ID，并在关闭时释放连接', async () => {
  const { root, runId } = await fixture()
  const server = await createServer({ projectDir: root, port: 0 })
  cleanups.push(() => server.close())
  const byHeader = new AbortController()
  const header = await fetch(`${server.url}/api/runs/${runId}/stream`, { headers: { 'last-event-id': '1' }, signal: byHeader.signal })
  expect(await firstChunk(header)).toContain('id: 2\n')
  byHeader.abort()
  const byQuery = new AbortController()
  const query = await fetch(`${server.url}/api/runs/${runId}/stream?after=3`, { headers: { 'last-event-id': '1' }, signal: byQuery.signal })
  expect(await firstChunk(query)).toContain('id: 4\n')
  byQuery.abort()
})

it('SSE 空历史立即发送响应头，空 after 返回 400', async () => {
  const { root, runId } = await fixture()
  const server = await createServer({ projectDir: root, port: 0 })
  cleanups.push(() => server.close())
  const controller = new AbortController()
  const response = await fetch(`${server.url}/api/runs/${runId}/stream?after=4`, {
    headers: { 'last-event-id': '1' }, signal: controller.signal,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  controller.abort()
  const empty = await fetch(`${server.url}/api/runs/${runId}/stream?after=`, { headers: { 'last-event-id': '1' } })
  expect(empty.status).toBe(400)
  expect(await empty.json()).toEqual({ error: 'after 不合法' })
})

it('SSE 历史读取失败在写响应头前返回 JSON 500', async () => {
  const { root, stores, runId } = await fixture()
  const server = await createServer({ projectDir: root, port: 0 })
  cleanups.push(() => server.close())
  await writeFile(join(stores.taktDir, 'runs', runId, 'events.jsonl'), '{')
  const response = await fetch(`${server.url}/api/runs/${runId}/stream`)
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: '服务器内部错误' })
})

it('SSE 适配器在空历史时立即写响应头，关闭时清理心跳、连接与监听', async () => {
  const writeHead = vi.fn()
  const flushHeaders = vi.fn()
  const write = vi.fn()
  const end = vi.fn()
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, headersSent: false, writeHead, flushHeaders, write, end, destroy: vi.fn(),
  }) as unknown as ServerResponse
  const controller = new AbortController()
  const stop = vi.fn()
  const events: EventStream = {
    ready: Promise.resolve(),
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<EventEnvelope>>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true })
      }),
      return: async () => { stop(); return { done: true, value: undefined } },
    }),
  }
  const connections = new Set<() => void>()
  const interval = vi.spyOn(globalThis, 'setInterval')
  const clear = vi.spyOn(globalThis, 'clearInterval')
  try {
    const streaming = streamEvents(events, controller, response, connections)
    await tick()
    expect(writeHead).toHaveBeenCalledOnce()
    expect(flushHeaders).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    expect(connections.size).toBe(1)
    const timer = interval.mock.results[0]!.value
    response.emit('close')
    await streaming
    expect(controller.signal.aborted).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledWith(timer)
    expect(connections.size).toBe(0)
    expect(end).not.toHaveBeenCalled()
    expect(response.listenerCount('close')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  } finally {
    interval.mockRestore()
    clear.mockRestore()
  }
})

it('legacy stream 先写响应头再同步回放历史，关闭后移除监听', async () => {
  const stop = vi.fn()
  const event = (seq: number) => ({ seq, runId: 'run', type: 'log' } as EventEnvelope)
  const events = { subscribe: () => stop, read: async () => [event(2), event(1)] } as unknown as EventStore
  const calls: string[] = []
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead: vi.fn(() => { calls.push('head') }),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => { calls.push(`write:${String(chunk).match(/^id: (\d+)/)![1]}`) }),
    end: vi.fn(),
  })
  const connections = new Set<() => void>()
  await stream(events, 'run', 0, response as unknown as ServerResponse, connections)
  expect(calls).toEqual(['head', 'write:1', 'write:2'])
  expect(connections.size).toBe(1)
  response.emit('close')
  expect(stop).toHaveBeenCalledOnce()
  expect(connections.size).toBe(0)
  expect(response.listenerCount('close')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
})

async function firstChunk(response: Response, timeoutMs = 3000): Promise<string> {
  const reader = response.body!.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read().then(({ value, done }) => {
        if (done) throw new Error('SSE 连接提前关闭')
        return new TextDecoder().decode(value)
      }),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('SSE 读取超时')), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
