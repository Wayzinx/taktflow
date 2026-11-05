import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject, readLease } from '@taktflow/core'
// 直接使用当前 server 源码验证接线；不依赖 packages/server/dist。
import { createApiCore } from '../../server/src/api-core.js'
import { createWriteLeaseHook } from './lease.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('真实 ApiCore 写操作在 serve 租约内执行 onAnswer，租约被占时返回 409', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-api-lease-'))
  roots.push(root)
  const stores = await initProject(root)
  await stores.attention.create({
    requestId: 'run-1:approval',
    runId: 'run-1',
    nodeId: 'approval',
    requirementId: 'REQ-001',
    ask: '继续？',
    form: 'approve',
  })
  const observed: Array<string | undefined> = []
  const core = createApiCore({
    withWriteLease: createWriteLeaseHook(),
    onAnswer: async () => {
      observed.push((await readLease(stores.taktDir))?.owner)
    },
  })
  const actor = { type: 'human', id: 'tester' } as const
  const answered = await core.write(stores, 'attention.answer', { requestId: 'run-1:approval' }, { decision: 'approve' }, actor)
  expect(answered).toMatchObject({ requestId: 'run-1:approval', decision: 'approve' })
  // onAnswer 在写租约内执行：此刻租约属于 serve:<pid>，写结束后释放。
  expect(observed).toEqual([`serve:${process.pid}`])
  expect(await readLease(stores.taktDir)).toBeUndefined()

  // 别人持有租约时，写和 onAnswer 都不执行，并映射成 409。
  await writeFile(path.join(stores.taktDir, 'lease.json'), JSON.stringify({
    owner: 'other',
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ttlMs: 60_000,
  }))
  const error = await core
    .write(stores, 'attention.answer', { requestId: 'run-1:approval' }, { decision: 'approve' }, actor)
    .catch((caught: unknown) => caught)
  expect(error).toMatchObject({ status: 409 })
  expect((error as Error).message).toContain('空间正被 other 使用')
  expect(observed).toHaveLength(1)
})
