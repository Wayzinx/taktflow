import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '@taktflow/core'
import { afterEach, expect, test, vi } from 'vitest'
import { FeishuQueue } from './feishu-queue.js'
import type { FeishuEnvelope } from './feishu-queue.js'

const queues: FeishuQueue[] = []
const roots: string[] = []
const message = { type: 'text', content: { text: '收到' } } as const
const hour = 60 * 60 * 1_000

afterEach(async () => {
  await Promise.all(queues.splice(0).map(queue => queue.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'feishu-queue-'))
  roots.push(root)
  return root
}

function create(root: string, services: ConstructorParameters<typeof FeishuQueue>[1]) {
  const queue = new FeishuQueue(root, services)
  queues.push(queue)
  return queue
}

function event(key: string, chatId = 'oc_chat'): FeishuEnvelope {
  return { key, spaceId: 'space', chatId, revision: 'original', memberId: 'member',
    event: { id: key, chatId, openId: 'ou_member', kind: 'action', value: {} } }
}

function path(root: string, key: string) { return join(root, `${sha256(key)}.json`) }
async function record(root: string, key: string) { return JSON.parse(await readFile(path(root, key), 'utf8')) as Record<string, unknown> }
function wait(check: () => void | Promise<void>) { return vi.waitFor(check, { interval: 10, timeout: 2_000 }) }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('入队不等业务回调；同一群按顺序执行并去重，其他群继续处理', async () => {
  const root = await temp()
  const actions: string[] = []
  const gate = deferred<void>()
  const prepare = vi.fn(async (envelope: FeishuEnvelope) => {
    actions.push(`prepare:${envelope.key}`)
    if (envelope.key === '../first') await gate.promise
    return message
  })
  const deliver = vi.fn(async (envelope: FeishuEnvelope) => { actions.push(`deliver:${envelope.key}`) })
  const queue = create(root, { prepare, deliver })
  queue.start()
  try {
    await queue.put(event('../first'))
    await wait(() => expect(prepare).toHaveBeenCalledTimes(1))
    await Promise.all([queue.put(event('second')), queue.put(event('../first')), queue.put(event('other', 'oc_other'))])
    await wait(() => expect(actions).toEqual(['prepare:../first', 'prepare:other', 'deliver:other']))
    expect((await readdir(root)).filter(name => name.endsWith('.json')).sort())
      .toEqual(['../first', 'second', 'other'].map(key => `${sha256(key)}.json`).sort())
    expect((await stat(path(root, '../first'))).mode & 0o777).toBe(0o600)
  } finally { gate.resolve() }
  await wait(() => expect(actions).toEqual([
    'prepare:../first', 'prepare:other', 'deliver:other', 'deliver:../first', 'prepare:second', 'deliver:second',
  ]))
  await queue.close()

  const reopened = create(root, { prepare, deliver })
  await reopened.put(event('../first'))
  reopened.start()
  expect((await record(root, '../first')).state).toBe('done')
  await reopened.close()
  expect(prepare).toHaveBeenCalledTimes(3)
  expect(deliver).toHaveBeenCalledTimes(3)
})

test('发送失败后重启使用落盘的回复和同一 UUID，不重跑业务', async () => {
  const root = await temp()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const prepare = vi.fn(async () => message)
  const deliver = vi.fn<ConstructorParameters<typeof FeishuQueue>[1]['deliver']>()
    .mockRejectedValueOnce(new Error('unexpected connection loss')).mockResolvedValue(undefined)
  const queue = create(root, { prepare, deliver })
  await queue.put(event('callback'))
  queue.kick()
  await wait(() => expect(deliver).toHaveBeenCalledTimes(1))
  await queue.close()
  expect(await record(root, 'callback')).toMatchObject({ message, state: 'pending', attempt: 1 })

  const reopened = create(root, { prepare, deliver })
  reopened.kick()
  await reopened.put(event('callback'))
  expect(deliver).toHaveBeenCalledTimes(1)
  now += 1_001
  reopened.kick()
  await wait(async () => expect((await record(root, 'callback')).state).toBe('done'))
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(deliver).toHaveBeenCalledTimes(2)
  expect(deliver.mock.calls[0]?.[2]).toMatch(/^[a-f0-9-]{36}$/)
  expect(deliver.mock.calls[1]).toEqual(deliver.mock.calls[0])
})

test('超过 UUID 时间窗的模糊结果不重发，同群后续消息可继续', async () => {
  const root = await temp()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const prepare = vi.fn(async () => undefined)
  const deliver = vi.fn<ConstructorParameters<typeof FeishuQueue>[1]['deliver']>()
    .mockRejectedValueOnce(new Error('timed out')).mockResolvedValue(undefined)
  const queue = create(root, { prepare, deliver })
  await queue.put({ ...event('ambiguous'), event: undefined, message })
  await queue.put({ ...event('following'), event: undefined, message })
  queue.start()
  await wait(() => expect(deliver).toHaveBeenCalledTimes(1))
  await queue.close()

  now += hour + 1
  const reopened = create(root, { prepare, deliver })
  reopened.start()
  await wait(async () => expect((await record(root, 'following')).state).toBe('done'))
  expect(await record(root, 'ambiguous')).toMatchObject({ state: 'dead', reason: 'delivery-window-expired' })
  expect(deliver.mock.calls.map(call => call[0].key)).toEqual(['ambiguous', 'following'])
  expect(prepare).not.toHaveBeenCalled()
})

test('关闭等待正在处理的任务，不发送刚生成的回复；重启重新校验已撤销绑定', async () => {
  const root = await temp()
  const gate = deferred<typeof message>()
  const prepare = vi.fn(async (envelope: FeishuEnvelope) => envelope.revision === revision ? gate.promise : undefined)
  const sent = vi.fn()
  const deliver = vi.fn(async (envelope: FeishuEnvelope) => { if (envelope.revision === revision) sent() })
  let revision = 'original'
  const queue = create(root, { prepare, deliver })
  await queue.put(event('in-progress'))
  await queue.put(event('waiting'))
  queue.start()
  try {
    await wait(() => expect(prepare).toHaveBeenCalledTimes(1))
    const stopped = vi.fn()
    const closing = queue.close().then(stopped)
    await expect(queue.put(event('late'))).rejects.toThrow('关闭')
    expect(stopped).not.toHaveBeenCalled()
    gate.resolve(message)
    await closing
  } finally { gate.resolve(message) }
  expect(deliver).not.toHaveBeenCalled()
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(await record(root, 'in-progress')).toMatchObject({ state: 'pending', message })

  revision = 'revoked'
  create(root, { prepare, deliver }).start()
  await wait(async () => expect((await record(root, 'waiting')).state).toBe('done'))
  expect(deliver).toHaveBeenCalledTimes(1)
  expect(prepare.mock.calls.map(call => call[0].key)).toEqual(['in-progress', 'waiting'])
  expect(sent).not.toHaveBeenCalled()
})

test('持续失败时按预算留下去重回执，超过保留期自动清理', async () => {
  const root = await temp()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const prepare = vi.fn(async () => { now += 10; throw new Error('preparation failure') })
  const deliver = vi.fn(async () => {})
  const queue = create(root, { prepare, deliver })
  await queue.put(event('error'))
  queue.start()
  for (const [index, delay] of [1_000, 5_000, 15_000, 60_000, 300_000].entries()) {
    await wait(async () => {
      expect(prepare).toHaveBeenCalledTimes(index + 1)
      expect((await record(root, 'error')).retryAt).toBe(now + delay)
    })
    now += delay + 1
    queue.kick()
  }
  await wait(async () => expect(await record(root, 'error')).toMatchObject({ state: 'dead', reason: 'prepare-failed' }))
  await queue.close()

  now += 24 * hour
  const reopened = create(root, { prepare, deliver })
  await reopened.put(event('error'))
  reopened.start()
  expect((await record(root, 'error')).state).toBe('dead')
  expect(prepare).toHaveBeenCalledTimes(6)
  now += 7 * 24 * hour
  reopened.kick()
  await wait(async () => expect(await readdir(root)).toEqual([]))
  expect(prepare).toHaveBeenCalledTimes(6)
  expect(deliver).not.toHaveBeenCalled()
})

test('拒绝符号链接指向的队列根和记录，不改写目标', async () => {
  const root = await temp()
  const outside = await temp()
  const prepare = vi.fn(async () => message)
  const deliver = vi.fn(async () => {})
  const alias = join(root, 'alias')
  await symlink(outside, alias)
  await expect(create(alias, { prepare, deliver }).put(event('root'))).rejects.toThrow('符号链接')
  expect(await readdir(outside)).toEqual([])

  const target = join(outside, 'target')
  await writeFile(target, 'do not touch')
  await symlink(target, path(root, 'entry'))
  const queue = create(root, { prepare, deliver })
  await expect(queue.put(event('entry'))).rejects.toThrow('符号链接')
  await queue.close()
  expect(await readFile(target, 'utf8')).toBe('do not touch')
  expect(prepare).not.toHaveBeenCalled()
  expect(deliver).not.toHaveBeenCalled()
})
