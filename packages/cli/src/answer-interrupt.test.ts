import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '@taktflow/core'
import { runAnswer } from './commands/answer.js'

vi.mock('./lease.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lease.js')>()
  return {
    ...actual,
    // 固定模拟"信号在命令开始时就已到达"，避免真实 SIGINT 的时序竞争。
    handleInterrupts: () => ({
      interrupted: true,
      drain: async () => undefined,
      dispose: () => undefined,
    }),
  }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('answer 在批准写之前发现已中断时返回 130，且不写入答复', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-answer-interrupt-'))
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
  const code = await runAnswer({
    positionals: ['run-1:approval'],
    options: {
      project: root,
      json: true,
      help: false,
      arg: [],
      autoApprove: false,
      approve: true,
      reject: false,
      noResume: true,
      takeover: false,
    },
  })
  expect(code).toBe(130)
  expect(await stores.attention.list({ pending: true })).toHaveLength(1)
  expect((await stores.attention.list())[0]?.answeredAt).toBeUndefined()
})
