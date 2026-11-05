import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { acquireLease, readLease, releaseLease, renewLease, type Lease } from './lease.js'
import { leaseFile } from './paths.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../../..')

const roots: string[] = []
let taktDir: string

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-lease-'))
  roots.push(root)
  taktDir = path.join(root, '.takt')
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  const pid = child.pid!
  await once(child, 'exit')
  return pid
}

async function writeLease(lease: Partial<Lease>): Promise<void> {
  await mkdir(taktDir, { recursive: true })
  await writeFile(leaseFile(taktDir), JSON.stringify({
    owner: 'other',
    pid: process.pid,
    host: hostname(),
    acquiredAt: '2020-01-01T00:00:00.000Z',
    heartbeatAt: '2020-01-01T00:00:00.000Z',
    ttlMs: 60_000,
    ...lease,
  }))
}

it('获取、同 owner 幂等续约、续约和释放', async () => {
  const first = await acquireLease(taktDir, 'cli:1')
  expect(first.ok).toBe(true)
  if (!first.ok) return
  expect(first.lease).toMatchObject({ owner: 'cli:1', pid: process.pid, host: hostname(), ttlMs: 60_000 })
  expect(await readLease(taktDir)).toEqual(first.lease)

  const again = await acquireLease(taktDir, 'cli:1', { now: () => new Date('2030-01-01T00:00:00.000Z') })
  expect(again).toEqual({ ok: true, lease: { ...first.lease, heartbeatAt: '2030-01-01T00:00:00.000Z' } })

  const renewed = await renewLease(taktDir, 'cli:1', { now: () => new Date('2031-01-01T00:00:00.000Z') })
  expect(renewed.heartbeatAt).toBe('2031-01-01T00:00:00.000Z')

  await releaseLease(taktDir, 'cli:1')
  expect(await readLease(taktDir)).toBeUndefined()
  await releaseLease(taktDir, 'cli:1')
})

it('别人持有且未失效时拒绝，takeover 也不能抢活租约', async () => {
  expect((await acquireLease(taktDir, 'cli:1')).ok).toBe(true)
  expect(await acquireLease(taktDir, 'cli:2')).toEqual({ ok: false, held: expect.objectContaining({ owner: 'cli:1' }), stale: false })
  expect(await acquireLease(taktDir, 'cli:2', { takeover: true })).toMatchObject({ ok: false, stale: false })
})

it('同 host 的进程已退出且超过 TTL 才算 stale，takeover 才能接管', async () => {
  const pid = await deadPid()
  await writeLease({ owner: 'cli:9', pid, heartbeatAt: '2020-01-01T00:00:00.000Z', ttlMs: 1 })
  const held = await acquireLease(taktDir, 'cli:2')
  expect(held).toMatchObject({ ok: false, stale: true })
  const taken = await acquireLease(taktDir, 'cli:2', { takeover: true })
  expect(taken.ok).toBe(true)
  if (taken.ok) expect(taken.lease.owner).toBe('cli:2')
})

it('同 host 进程仍存活时即使超过 TTL 也不能接管', async () => {
  await writeLease({ owner: 'cli:9', pid: process.pid, heartbeatAt: '2020-01-01T00:00:00.000Z', ttlMs: 1 })
  expect(await acquireLease(taktDir, 'cli:2', { takeover: true })).toMatchObject({ ok: false, stale: false })
})

it('跨 host 只看 TTL', async () => {
  await writeLease({ host: 'another-host', heartbeatAt: new Date().toISOString(), ttlMs: 60_000 })
  expect(await acquireLease(taktDir, 'cli:2')).toMatchObject({ ok: false, stale: false })
  await writeLease({ host: 'another-host', heartbeatAt: '2020-01-01T00:00:00.000Z', ttlMs: 1 })
  expect(await acquireLease(taktDir, 'cli:2')).toMatchObject({ ok: false, stale: true })
  expect((await acquireLease(taktDir, 'cli:2', { takeover: true })).ok).toBe(true)
})

it('并发接管只有一个成功', async () => {
  await writeLease({ owner: 'dead', pid: await deadPid(), heartbeatAt: '2020-01-01T00:00:00.000Z', ttlMs: 1 })
  const results = await Promise.all([
    acquireLease(taktDir, 'cli:a', { takeover: true }),
    acquireLease(taktDir, 'cli:b', { takeover: true }),
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toHaveLength(1)
})

function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const index = buffer.indexOf('\n')
      if (index < 0) return
      child.stdout.off('data', onData)
      resolve(buffer.slice(0, index))
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
  })
}

it('两个真实子进程同时接管失效租约，只有一个成功', async () => {
  const root = path.dirname(taktDir)
  await writeLease({ owner: 'dead', pid: await deadPid(), heartbeatAt: '2020-01-01T00:00:00.000Z', ttlMs: 1 })
  const barrier = path.join(root, 'start')
  const script = path.join(root, 'takeover.mjs')
  // 子进程在 barrier 出现后同时尝试接管；获胜者保持存活，落败者才可能看到"未失效"。
  await writeFile(script, `
import { readFile } from 'node:fs/promises'
import { acquireLease } from ${JSON.stringify(path.join(here, 'lease.ts'))}
const [taktDir, owner, barrier] = process.argv.slice(2)
for (;;) {
  try { await readFile(barrier); break } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
}
const result = await acquireLease(taktDir, owner, { takeover: true })
process.stdout.write(JSON.stringify(result) + '\\n')
if (result.ok) process.stdin.resume()
else process.exit(0)
`)
  const owners = ['cli:a', 'cli:b']
  const children = owners.map((owner) => spawn(
    process.execPath,
    ['--import', 'tsx', script, taktDir, owner, barrier],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  ))
  try {
    await writeFile(barrier, 'go')
    const results = await Promise.all(children.map(firstLine))
    const parsed = results.map((line) => JSON.parse(line) as { ok: boolean; lease?: Lease; held?: Lease })
    expect(parsed.filter((result) => result.ok)).toHaveLength(1)
    expect(parsed.filter((result) => !result.ok)).toHaveLength(1)
    const winner = parsed.find((result) => result.ok)!
    expect(owners).toContain(winner.lease?.owner)
    expect((await readLease(taktDir))?.owner).toBe(winner.lease?.owner)
  } finally {
    for (const child of children) child.kill('SIGKILL')
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('exit', () => resolve())
    })))
  }
}, 20000)

it('非持有者不能续约或释放，损坏的租约文件直接报错', async () => {
  expect((await acquireLease(taktDir, 'cli:1')).ok).toBe(true)
  await expect(renewLease(taktDir, 'cli:2')).rejects.toThrow('不属于 cli:2')
  await expect(releaseLease(taktDir, 'cli:2')).rejects.toThrow('不能释放')
  await writeFile(leaseFile(taktDir), '{"owner":"broken"}\n')
  await expect(acquireLease(taktDir, 'cli:3')).rejects.toThrow('租约文件损坏')
})
