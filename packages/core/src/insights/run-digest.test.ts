import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { RunState } from '../types.js'
import { runDigest } from './run-digest.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('运行摘要按事件文件与运行状态缓存：没变不重算，追加事件或状态变了就重算，并发只算一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-run-digest-'))
  roots.push(root)
  const stores = await initProject(root)
  const state = { runId: 'run-digest', requirementId: 'REQ-001', workflowId: 'w', status: 'succeeded', nodes: {} } as unknown as RunState
  const actor = { type: 'system' as const, id: 'engine' }
  let computed = 0
  const count = () => runDigest(stores, state, 'test', (events) => (computed++, events.length))

  // 还没有事件文件：不缓存
  expect(await count()).toBe(0)
  expect(await count()).toBe(0)
  expect(computed).toBe(2)

  await stores.events.append(state.runId, { type: 'log', actor, data: { level: 'info', message: '一' } })
  computed = 0
  expect(await Promise.all([count(), count(), count()])).toEqual([1, 1, 1])
  expect(await count()).toBe(1)
  expect(computed).toBe(1)

  await stores.events.append(state.runId, { type: 'log', actor, data: { level: 'info', message: '二' } })
  expect(await count()).toBe(2)
  expect(computed).toBe(2)

  state.status = 'failed'
  expect(await count()).toBe(2)
  expect(computed).toBe(3)
  // 同一运行、不同名字的摘要各算各的
  expect(await runDigest(stores, state, 'other', (events) => events.map((event) => event.type))).toEqual(['log', 'log'])
})
