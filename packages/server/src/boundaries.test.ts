import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, openProject, type EventEnvelope, type EventStore, type RunState, type WorkflowSnapshot } from '@taktflow/core'
import { createServer } from './index.js'
import { stream } from './stream.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-server-boundary-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ id: 'REQ-1', title: '边界' })
  const ref = await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'spec.md' }, content: 'v1', kind: 'spec', author: { type: 'system', id: 'fixture' } })
  const snapshot: WorkflowSnapshot = {
    id: 'wf', version: '1', title: '流程', stages: [{ id: 'dev', title: '研发' }],
    nodes: [
      { id: 'loop', kind: 'loop', title: '循环', stage: 'dev', needs: [], body: [{ id: 'child', kind: 'agent', title: '内部节点', needs: [], prompt: '静态 prompt' }] },
      { id: 'after', kind: 'script', title: '后继', stage: 'dev', needs: ['loop'] },
      { id: 'planner', kind: 'planner', title: '规划', stage: 'dev', needs: [] },
      { id: 'unrelated', kind: 'script', title: '其他', needs: [] },
    ],
  }
  const state: RunState = {
    runId: 'run-1', requirementId: requirement.id, workflowId: 'wf', workflowVersion: '1', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', args: {},
    nodes: Object.fromEntries(['loop', 'loop/child', 'after', 'planner', 'planner/a/task', 'planner/b/task', 'planner/c/task', 'unrelated'].map((id) => [id, { id, status: 'succeeded', attempts: 1, outputs: [], ...(id === 'loop/child' || id === 'planner/a/task' ? { inputs: [ref] } : {}) }])),
    expansions: [{ plannerId: 'planner', nodeIds: ['planner/a/task', 'planner/b/task', 'planner/c/task'], items: [{ key: 'a', title: 'a' }, { key: 'b', title: 'b', dependsOn: ['a'] }], at: '2026-01-01T00:00:00Z' }],
  }
  await stores.runs.create(state, snapshot)
  const graph = { nodes: [
    { id: 'loop', needs: [] }, { id: 'loop/child', needs: [], parent: 'loop' },
    { id: 'after', needs: ['loop'] }, { id: 'planner', needs: [] },
    { id: 'planner/a/task', needs: [], parent: 'planner', kind: 'agent', title: '实现 A', role: 'dev', stage: 'dev', harness: 'mock' },
    { id: 'planner/b/task', needs: ['planner/a/task'], parent: 'planner' },
    { id: 'planner/c/task', needs: [], parent: 'planner' }, { id: 'unrelated', needs: [] },
  ], requests: {} }
  await writeFile(join(stores.taktDir, 'runs/run-1/engine.json'), JSON.stringify(graph))
  const server = await createServer({ projectDir: root, port: 0 })
  cleanups.push(() => server.close())
  return { root, stores, server, state, snapshot, graph }
}

it('编辑传播到所有运行、loop 父容器及后继、动态依赖但不波及兄弟；同内容不重复写事件', async () => {
  const { stores, server, state, snapshot, graph } = await fixture()
  await stores.runs.create({ ...state, runId: 'run-2', startedAt: '2026-02-01T00:00:00Z' }, snapshot)
  await writeFile(join(stores.taktDir, 'runs/run-2/engine.json'), JSON.stringify(graph))
  const edit = async (content: string) => {
    const response = await fetch(`${server.url}/api/requirements/REQ-1/artifact?path=spec.md`, { method: 'PUT', body: JSON.stringify({ content, reason: '修改规格' }) })
    expect(response.status).toBe(200)
    return response.json() as Promise<{ version: number; staleNodes: Array<{ runId: string; nodeId: string }> }>
  }
  const changed = await edit('v2')
  expect(changed.version).toBe(2)
  expect(changed.staleNodes).toHaveLength(12)
  for (const runId of ['run-1', 'run-2']) {
    const state = await stores.runs.get(runId)
    for (const id of ['loop', 'loop/child', 'after', 'planner', 'planner/a/task', 'planner/b/task']) expect(state!.nodes[id]!.status).toBe('stale')
    expect(state!.nodes['planner/c/task']!.status).toBe('succeeded')
    expect(state!.nodes.unrelated!.status).toBe('succeeded')
    const events = await stores.events.read(runId)
    expect(events).toHaveLength(7)
    expect(events.filter((event) => event.type === 'artifact.edited')).toHaveLength(1)
    expect(events.every((event) => event.actor.type === 'human' && event.actor.id === 'web')).toBe(true)
    expect(await stores.events.verify(runId)).toEqual({ ok: true })
  }
  expect(await edit('v2')).toEqual({ version: 2, staleNodes: [] })
  expect((await stores.events.read('run-1'))).toHaveLength(7)
  expect((await edit('v3')).staleNodes).toHaveLength(12)
  expect((await stores.events.read('run-1'))).toHaveLength(14)
  expect((await stores.workspaces.readArtifact({ workspace: 'REQ-1', path: 'spec.md', version: 1 }))?.toString()).toBe('v1')
})

it('每请求读最新配置与运行；无运行需求阶段为空；prompt 使用运行事件并合并上下文', async () => {
  const { root, stores, server, state, snapshot } = await fixture()
  await stores.workspaces.createRequirement({ id: 'REQ-2', title: '尚未运行' })
  await stores.runs.create({ ...state, runId: 'run-latest', startedAt: '2026-03-01T00:00:00Z', nodes: {} }, { ...snapshot, stages: [{ id: 'new', title: '新阶段' }] })
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ project: { name: '新名字' }, workflows: [] }))
  const overview = await (await fetch(`${server.url}/api/project`)).json()
  expect(overview.name).toBe('新名字')
  expect(overview.requirements[0]).toMatchObject({ latestRunId: 'run-latest', stages: [{ id: 'new', status: 'todo', done: 0, total: 0 }] })
  expect(overview.requirements[1].stages).toEqual([])
  const context = { nodeId: 'loop/child', at: '2026-03-01T00:00:01Z', budgetTokens: 1000, totalTokens: 2, items: [] }
  await stores.runs.saveContext('run-1', context)
  await stores.events.append('run-1', { nodeId: 'loop/child', type: 'context.assembled', actor: { type: 'system', id: 'test' }, data: context })
  await stores.events.append('run-1', { nodeId: 'loop/child', type: 'harness.message', actor: { type: 'system', id: 'test' }, data: { role: 'user', text: '实际 prompt' } })
  const detail = await (await fetch(`${server.url}/api/runs/run-1/nodes/loop%2Fchild`)).json()
  expect(detail.prompt).toBe('实际 prompt')
  expect(detail.context.snapshots).toEqual([context])
})

it('非法参数返回 400、缺失实体返回 404、存储损坏返回 500，并限制 CORS', async () => {
  const { root, server } = await fixture()
  for (const route of ['/api/runs/run-1/events?after=-1', '/api/runs/run-1/events?after=1.5', '/api/runs/run-1/stream?after=NaN', '/api/requirements/REQ-1/artifact?path=..%2Fsecret', '/api/runs/run-1/nodes/%ZZ', '/api/attention?pending=wrong']) {
    const response = await fetch(server.url + route)
    expect(response.status, route).toBe(400)
    expect((await response.json()).error).toEqual(expect.any(String))
  }
  expect((await fetch(`${server.url}/api/runs/absent/audit`)).status).toBe(404)
  const malformed = await fetch(`${server.url}/api/attention/id`, { method: 'POST', body: '{' })
  expect(malformed.status).toBe(400)
  const preflight = await fetch(`${server.url}/api/requirements/REQ-1/artifact`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-takt-user' } })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Takt-User')
  expect((await fetch(`${server.url}/api/project`, { headers: { origin: 'https://example.org' } })).headers.has('access-control-allow-origin')).toBe(false)
  await writeFile(join(root, '.takt/runs/run-1/state.json'), '{')
  const broken = await fetch(`${server.url}/api/runs/run-1`)
  expect(broken.status).toBe(500)
  expect(await broken.json()).toEqual({ error: expect.any(String) })
})

it('静态托管不能沿符号链接越界，未知 API 不回退 SPA', async () => {
  const { root } = await fixture()
  const webDir = join(root, 'web')
  await mkdir(webDir)
  await writeFile(join(webDir, 'index.html'), '<main>SPA</main>')
  await writeFile(join(root, 'outside.txt'), 'private-content')
  await symlink(join(root, 'outside.txt'), join(webDir, 'leak.txt'))
  const server = await createServer({ projectDir: root, webDir, port: 0 })
  cleanups.push(() => server.close())
  const leak = await fetch(`${server.url}/leak.txt`)
  expect(leak.status).toBe(404)
  expect(await leak.text()).not.toContain('private-content')
  expect((await fetch(`${server.url}/api/absent`)).status).toBe(404)
  expect(await (await fetch(`${server.url}/client/path`)).text()).toContain('SPA')
})

it('SSE 在历史回放期间有追加时按序去重，关闭时取消订阅', async () => {
  let subscribed: ((event: EventEnvelope) => void) | undefined
  const stop = vi.fn()
  const event = (seq: number) => ({ seq, runId: 'run', type: 'log' } as EventEnvelope)
  const events = {
    subscribe: (_: string, receive: (event: EventEnvelope) => void) => { subscribed = receive; return stop },
    read: async () => { subscribed!(event(2)); subscribed!(event(3)); return [event(1), event(2)] },
  } as unknown as EventStore
  const response = Object.assign(new EventEmitter(), { destroyed: false, writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn() })
  const connections = new Set<() => void>()
  await stream(events, 'run', 0, response as unknown as ServerResponse, connections)
  const received = () => response.write.mock.calls.map(([chunk]) => Number(String(chunk).match(/^id: (\d+)/)![1]))
  expect(received()).toEqual([1, 2, 3])
  subscribed!(event(3))
  subscribed!(event(4))
  expect(received()).toEqual([1, 2, 3, 4])
  response.emit('close')
  expect(stop).toHaveBeenCalledOnce()
  expect(connections.size).toBe(0)
})

it('SSE 只发送 after 之后事件，活跃连接随 server.close 结束且重复关闭安全', async () => {
  const { root, stores, server } = await fixture()
  for (let i = 0; i < 2; i++) await stores.events.append('run-1', { type: 'log', actor: { type: 'system', id: 'test' }, data: { level: 'info', message: String(i) } })
  const response = await fetch(`${server.url}/api/runs/run-1/stream?after=1`)
  const reader = response.body!.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(first).toContain('id: 2\n')
  expect(first).not.toContain('id: 1\n')
  const external = await openProject(root)
  await external.events.append('run-1', { type: 'log', actor: { type: 'system', id: 'external' }, data: { level: 'info', message: 'new' } })
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: 3\n')
  await server.close()
  await server.close()
  expect(await reader.read()).toMatchObject({ done: true })
})

it('动态节点使用持久化图的元数据与依赖，实际 prompt 优先于快照', async () => {
  const { stores, server } = await fixture()
  const nodeId = 'planner/a/task'
  await stores.events.append('run-1', { nodeId, type: 'harness.message', actor: { type: 'system', id: 'test' }, data: { role: 'user', text: '本轮 TC-2：修复空名字' } })
  const detail = await (await fetch(`${server.url}/api/runs/run-1/nodes/${encodeURIComponent(nodeId)}`)).json()
  expect(detail).toMatchObject({ kind: 'agent', title: '实现 A', role: 'dev', stage: 'dev', prompt: '本轮 TC-2：修复空名字' })
  const run = await (await fetch(`${server.url}/api/runs/run-1`)).json()
  expect(run.graph.edges).toContainEqual({ from: nodeId, to: 'planner/b/task', kind: 'dep' })
})

it('已有新版本输入不会 stale', async () => {
  const { stores, server, state } = await fixture()
  state.nodes['loop/child']!.inputs![0]!.version = 2
  state.nodes['planner/a/task']!.inputs![0]!.version = 2
  await stores.runs.save(state)
  const response = await fetch(`${server.url}/api/requirements/REQ-1/artifact?path=spec.md`, { method: 'PUT', body: JSON.stringify({ content: 'v2', reason: '同步新版本' }) })
  expect(await response.json()).toEqual({ version: 2, staleNodes: [] })
})

it.each(['deleted', 'conflicting'] as const)('Expansion.nodes 驱动图与 stale，engine.json 为 %s 时仍使用新定义', async (legacy) => {
  const { stores, server, state } = await fixture()
  state.expansions[0]!.nodes = [
    { id: 'planner/a/task', kind: 'agent', title: '新实现 A', role: 'dev', harness: 'mock', prompt: '展开快照 prompt', needs: [] },
    { id: 'planner/b/task', kind: 'gate', title: '新检查 B', needs: ['planner/a/task'], checks: [{ id: 'rubric', kind: 'rubric', threshold: 85 }] },
    { id: 'planner/c/task', kind: 'human', title: '独立审批', needs: [], ask: '请选择', form: 'choice', choices: ['是', '否'] },
  ]
  await stores.runs.save(state)
  const engineFile = join(stores.taktDir, 'runs/run-1/engine.json')
  if (legacy === 'deleted') await rm(engineFile)
  else await writeFile(engineFile, JSON.stringify({ nodes: [
    { id: 'planner/a/task', kind: 'script', title: '旧 A', role: 'old', needs: [], parent: 'unrelated', stage: 'wrong' },
    { id: 'planner/b/task', kind: 'script', title: '旧 B', needs: [], parent: 'planner' },
    { id: 'planner/c/task', kind: 'script', title: '旧 C', needs: ['planner/a/task'], parent: 'planner' },
  ], requests: {}, attempts: {} }))
  const detailResponse = await fetch(`${server.url}/api/runs/run-1`)
  expect(detailResponse.status).toBe(200)
  const detail = await detailResponse.json()
  expect(detail.graph.nodes.find((node: { id: string }) => node.id === 'planner/a/task')).toMatchObject({ kind: 'agent', title: '新实现 A', parent: 'planner', stage: 'dev', role: 'dev', harness: 'mock' })
  expect(detail.graph.edges).toContainEqual({ from: 'planner/a/task', to: 'planner/b/task', kind: 'dep' })
  expect(detail.graph.edges).not.toContainEqual({ from: 'planner/a/task', to: 'planner/c/task', kind: 'dep' })
  expect(detail.stages).toEqual([{ id: 'dev', title: '研发', status: 'done', done: 7, total: 7 }])
  const nodeResponse = await fetch(`${server.url}/api/runs/run-1/nodes/planner%2Fa%2Ftask`)
  expect(nodeResponse.status).toBe(200)
  expect(await nodeResponse.json()).toMatchObject({ kind: 'agent', prompt: '展开快照 prompt' })
  const response = await fetch(`${server.url}/api/requirements/REQ-1/artifact?path=spec.md`, { method: 'PUT', body: JSON.stringify({ content: 'v2', reason: '新定义传播' }) })
  expect(response.status).toBe(200)
  const changed = await response.json()
  expect(changed.staleNodes.map((item: { nodeId: string }) => item.nodeId).sort()).toEqual(['after', 'loop', 'loop/child', 'planner', 'planner/a/task', 'planner/b/task'])
  const persisted = await stores.runs.get('run-1')
  expect(persisted!.nodes['planner/b/task']!.status).toBe('stale')
  expect(persisted!.nodes['planner/c/task']!.status).toBe('succeeded')
  expect(persisted!.nodes.unrelated!.status).toBe('succeeded')
  expect(persisted!.expansions).toEqual(state.expansions)
  expect(await stores.events.verify('run-1')).toEqual({ ok: true })
  const reloaded = await (await fetch(`${server.url}/api/runs/run-1`)).json()
  expect(reloaded.stages).toEqual([{ id: 'dev', title: '研发', status: 'running', done: 1, total: 7 }])
})
