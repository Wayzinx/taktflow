import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, openProject } from '../store/project.js'
import type { DelegationStatus, RunState } from '../types.js'
import { DEFAULT_RECEIPT_TIMEOUT_MINUTES, expireTaskReceipts, recoverTaskReceipts, trackTaskExecution } from './receipts.js'
import { startMaintenance } from '../../../server/src/maintenance.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-receipts-')); roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '回执' })
  const post = (runId: string, status: DelegationStatus) => stores.chat.post(requirement.id, {
    author: { type: 'system', id: 'test' }, kind: 'task', text: '任务', refs: { taskRunId: runId, runId },
    receipt: { status, hops: 2, chain: ['upstream'] },
  })
  async function run(runId: string, status: RunState['status']) {
    await stores.runs.create({ runId, status, workflowId: 'task:dev', workflowVersion: '1', requirementId: requirement.id,
      startedAt: new Date().toISOString(), args: {}, nodes: {}, expansions: [], kind: 'task' },
    { id: 'task:dev', title: '任务', version: '1', stages: [], nodes: [] })
  }
  return { stores, requirement, post, run }
}

it.each([undefined, 5])('按配置或默认 30 分钟过期，只追加并保留链路（%s）', async minutes => {
  const { stores, requirement, post } = await setup()
  stores.config.lead = minutes === undefined ? undefined : { receiptTimeoutMinutes: minutes }
  const original = await post('waiting', 'sent')
  const deadline = Date.parse(original.at) + (minutes ?? DEFAULT_RECEIPT_TIMEOUT_MINUTES) * 60_000
  expect(await expireTaskReceipts(stores, deadline - 1)).toEqual([])
  const [expired] = await expireTaskReceipts(stores, deadline)
  expect(expired).toMatchObject({ kind: 'task', replyTo: original.id, refs: original.refs,
    receipt: { status: 'expired', hops: 2, chain: ['upstream'] } })
  expect(expired!.receipt!.note).toContain('先查看群聊')
  expect(await expireTaskReceipts(stores, deadline + 60_000)).toEqual([])
  expect((await (await openProject(stores.projectDir)).chat.list(requirement.id)).filter(message => message.kind === 'task')).toEqual([original, expired])
})

it('按每个任务最新回执判断，跳过全部非 sent 状态；并发扫描幂等', async () => {
  const { stores, requirement, post } = await setup()
  for (const status of ['taken', 'started', 'done', 'replied', 'refused', 'expired', 'uncertain'] as const) {
    await post(status, 'sent')
    await post(status, status)
  }
  const waiting = await post('waiting', 'sent')
  await stores.chat.post(requirement.id, { kind: 'task', author: waiting.author, text: '无运行的转达', receipt: { status: 'sent' } })
  const now = Date.parse(waiting.at) + 31 * 60_000
  const reopened = await openProject(stores.projectDir)
  const results = await Promise.all([expireTaskReceipts(stores, now), expireTaskReceipts(reopened, now)])
  expect(results.flat()).toHaveLength(1)
  expect(results.flat()[0]!.refs?.taskRunId).toBe('waiting')
  expect(await expireTaskReceipts(stores, now)).toEqual([])
})

it('启动恢复仅标记丢失与非本进程的未结束运行，已结束或本进程执行的保留', async () => {
  const { stores, requirement, post, run } = await setup()
  const originals = []
  for (const [runId, status, receipt] of [
    ['missing', undefined, 'sent'], ['missing-taken', undefined, 'taken'],
    ['orphan', 'running', 'sent'], ['paused', 'waiting_human', 'taken'],
    ['live', 'running', 'sent'], ['success', 'succeeded', 'sent'],
    ['failure', 'failed', 'taken'], ['cancelled', 'cancelled', 'sent'],
    ['started', 'running', 'started'], ['expired', undefined, 'expired'],
  ] as const) {
    if (status) await run(runId, status)
    originals.push(await post(runId, receipt))
  }
  const stop = trackTaskExecution(stores, 'live')
  try {
    const results = await recoverTaskReceipts(await openProject(stores.projectDir))
    expect(results.map(message => message.refs?.taskRunId)).toEqual(['missing', 'missing-taken', 'orphan', 'paused'])
    for (const result of results) expect(result.receipt).toEqual({ status: 'uncertain', hops: 2, chain: ['upstream'], note: '服务重启，可能已送达，重发前先看群聊' })
    expect(await recoverTaskReceipts(stores)).toEqual([])
    expect((await stores.chat.list(requirement.id)).filter(message => message.kind === 'task').slice(0, originals.length)).toEqual(originals)
  } finally { stop() }
  expect((await recoverTaskReceipts(stores)).map(message => message.refs?.taskRunId)).toEqual(['live'])
})

it('serve 维护启动恢复，后续 tick 过期且不再次把新任务当作重启遗留', async () => {
  const { stores, requirement, post } = await setup()
  await post('restart', 'sent')
  const errors = vi.fn()
  const maintenance = startMaintenance(() => [stores], undefined, errors)
  try {
    await vi.waitFor(async () => expect((await stores.chat.list(requirement.id)).at(-1)?.receipt?.status).toBe('uncertain'))
    stores.config.lead = { receiptTimeoutMinutes: 0 }
    const sent = await post('new-task', 'sent')
    await maintenance.tick()
    expect((await stores.chat.list(requirement.id)).at(-1)).toMatchObject({ replyTo: sent.id, receipt: { status: 'expired' } })
    const count = (await stores.chat.list(requirement.id)).length
    await maintenance.tick()
    expect(await stores.chat.list(requirement.id)).toHaveLength(count)
  } finally { await maintenance.close() }
  expect(errors).not.toHaveBeenCalled()
})

it('等人交还触发长运行时，下一轮回执维护仍然推进', async () => {
  const { stores, requirement, post, run } = await setup()
  await run('human', 'waiting_human')
  await stores.attention.create({ requestId: 'human:answer', runId: 'human', nodeId: 'answer', requirementId: requirement.id,
    kind: 'human', form: 'answer', ask: '采用默认值？', assumption: '使用默认值', timebox: { handbackAfter: '0.000001m' } })
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const onAnswer = vi.fn(async () => blocked), errors = vi.fn()
  const maintenance = startMaintenance(() => [stores], onAnswer, errors)
  const first = maintenance.tick()
  let second: Promise<void> | undefined
  try {
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1))
    stores.config.lead = { receiptTimeoutMinutes: 0 }
    const sent = await post('waiting', 'sent')
    second = maintenance.tick()
    await vi.waitFor(async () => expect((await stores.chat.list(requirement.id)).at(-1)).toMatchObject({ replyTo: sent.id, receipt: { status: 'expired' } }))
  } finally {
    release()
    await Promise.all([first, second])
    await maintenance.close()
  }
  expect(errors).not.toHaveBeenCalled()
})
