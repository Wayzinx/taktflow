import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessAdapter, TaktConfig } from '@taktflow/core'
import * as harnesses from '@taktflow/harness'
import { availabilityKey, clearHarnessAvailability, harnessAvailability, ProbeCache } from './harness-availability.js'
import { testRuntime } from './runtime-test.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const config: TaktConfig = { project: { name: '缓存测试' }, workflows: [] }
const adapter = (available: HarnessAdapter['available']): HarnessAdapter => ({ id: 'synthetic', displayName: 'Synthetic', available, run: async () => ({ ok: true, finalText: '' }) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('同键并发只探测一次，完整结果在完成后 60 秒内复用', async () => {
  vi.useFakeTimers()
  const cache = new ProbeCache<Awaited<ReturnType<HarnessAdapter['available']>>>()
  const pending = deferred<Awaited<ReturnType<HarnessAdapter['available']>>>()
  const probe = vi.fn(() => pending.promise)
  const requests = Array.from({ length: 8 }, () => cache.get('same', probe))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(probe).toHaveBeenCalledOnce()
  const result = { ok: true, reason: '说明', detail: '版本', ownReady: false, ownReason: '请登录' }
  pending.resolve(result)
  expect(await Promise.all(requests)).toEqual(Array.from({ length: 8 }, () => result))
  await vi.advanceTimersByTimeAsync(59_999)
  expect(await cache.get('same', probe)).toEqual(result)
  expect(probe).toHaveBeenCalledOnce()
})

it('过期立即返回旧值，后台刷新去重并在完成后更新结果', async () => {
  vi.useFakeTimers()
  const cache = new ProbeCache<{ ok: boolean }>()
  const next = deferred<{ ok: boolean }>()
  const probe = vi.fn().mockResolvedValueOnce({ ok: false }).mockImplementationOnce(() => next.promise)
  await cache.get('same', probe)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await Promise.all([cache.get('same', probe), cache.get('same', probe)])).toEqual([{ ok: false }, { ok: false }])
  expect(probe).toHaveBeenCalledTimes(2)
  next.resolve({ ok: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(await cache.get('same', probe)).toEqual({ ok: true })
  expect(probe).toHaveBeenCalledTimes(2)
})

it('后台异常不会产生未处理拒绝，失败结果也缓存', async () => {
  vi.useFakeTimers()
  const cache = new ProbeCache<boolean>()
  await cache.get('same', async () => true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await cache.get('same', async () => { throw new Error('offline') })).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  const probe = vi.fn(async () => { throw new Error('synthetic failure') })
  const scope = join(tmpdir(), 'availability-failure')
  clearHarnessAvailability(scope)
  expect(await harnessAvailability(config, scope, adapter(probe))).toEqual({ ok: false, reason: 'synthetic failure' })
  await harnessAvailability(config, scope, adapter(probe))
  expect(probe).toHaveBeenCalledOnce()
})

it('命令、env、transport、自定义探测配置改变时键不同，env 顺序不影响键且不保存明文', async () => {
  const settings = (env: Record<string, string>, command = 'synthetic-cli'): TaktConfig => ({ ...config, harnessOverrides: { codex: { command, env } } })
  const first = settings({ B: 'two', A: 'synthetic-secret' })
  const key = (value: TaktConfig) => availabilityKey(value, harnesses.createHarnesses({ config: value }).codex!)
  expect(key(first)).toBe(key(settings({ A: 'synthetic-secret', B: 'two' })))
  expect(key(first)).not.toContain('synthetic-secret')
  expect(key(first)).not.toBe(key(settings({ A: 'changed', B: 'two' })))
  expect(key(first)).not.toBe(key(settings({ A: 'synthetic-secret', B: 'two' }, 'other-cli')))
  const custom: TaktConfig = { ...config, harnesses: [{ id: 'synthetic', kind: 'cli', command: ['synthetic-cli'], available: ['synthetic-cli', '--check'], output: { format: 'text' } }] }
  const a = adapter(async () => ({ ok: true }))
  const before = availabilityKey(custom, a)
  custom.harnesses![0] = { ...custom.harnesses![0]!, kind: 'acp', command: ['synthetic-cli'] }
  expect(availabilityKey(custom, a)).not.toBe(before)
  const probe = vi.fn(async () => ({ ok: true }))
  const scope = join(tmpdir(), 'availability-config')
  clearHarnessAvailability(scope)
  await harnessAvailability(config, scope, adapter(probe))
  await harnessAvailability({ ...config, harnessOverrides: { synthetic: { env: { A: 'changed' } } } }, scope, adapter(probe))
  expect(probe).toHaveBeenCalledTimes(2)
})

it('手工测试强制重探并回填，旧的在途探测不能覆盖新结果', async () => {
  const scope = join(tmpdir(), 'availability-force')
  clearHarnessAvailability(scope)
  const old = deferred<{ ok: boolean }>()
  const fresh = deferred<{ ok: boolean; detail: string }>()
  const probe = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise)
  const harness = adapter(probe)
  const initial = harnessAvailability(config, scope, harness)
  const request = { target: { kind: 'harness' as const, id: harness.id } }
  const tests = [testRuntime(config, request, async () => ({ synthetic: harness }), undefined, undefined, scope),
    testRuntime(config, request, async () => ({ synthetic: harness }), undefined, undefined, scope)]
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
  fresh.resolve({ ok: true, detail: 'new version' })
  expect(await Promise.all(tests)).toEqual([expect.objectContaining({ ok: true, detail: 'new version' }), expect.objectContaining({ ok: true, detail: 'new version' })])
  old.resolve({ ok: false }); await initial
  expect(await harnessAvailability(config, scope, harness)).toEqual({ ok: true, detail: 'new version' })
  await testRuntime(config, request, async () => ({ synthetic: adapter(async () => ({ ok: false, reason: 'new failure' })) }), undefined, undefined, scope)
  expect(await harnessAvailability(config, scope, harness)).toMatchObject({ ok: false, reason: 'new failure' })
})

it('TTL 刷新和测试重建注册适配器，绕过适配器内部缓存，不运行真 CLI', async () => {
  vi.useFakeTimers()
  const scope = join(tmpdir(), 'availability-rebuild')
  clearHarnessAvailability(scope)
  const original = harnesses.createHarnesses({ config }).dsh!
  const originalProbe = vi.spyOn(original, 'available')
  const probe = vi.fn(async () => ({ ok: true, ownReady: true }))
  const create = harnesses.createHarnesses
  const factory = vi.spyOn(harnesses, 'createHarnesses').mockImplementation(() => {
    const fresh = create({ config }).dsh!
    fresh.available = probe
    return { dsh: fresh }
  })
  await harnessAvailability(config, scope, original)
  await harnessAvailability(config, scope, original)
  expect(factory).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60_000)
  await harnessAvailability(config, scope, original)
  await vi.advanceTimersByTimeAsync(0)
  await harnessAvailability(config, scope, original, true)
  expect(factory).toHaveBeenCalledTimes(3)
  expect(probe).toHaveBeenCalledTimes(3)
  expect(originalProbe).not.toHaveBeenCalled()
})

it('配置失效后重新探测，失效前的在途结果不会复活', async () => {
  const scope = join(tmpdir(), 'availability-clear')
  clearHarnessAvailability(scope)
  const pending = deferred<{ ok: boolean }>()
  const old = harnessAvailability(config, scope, adapter(() => pending.promise))
  clearHarnessAvailability(scope)
  const probe = vi.fn(async () => ({ ok: true }))
  await harnessAvailability(config, scope, adapter(probe))
  pending.resolve({ ok: false }); await old
  expect(await harnessAvailability(config, scope, adapter(probe))).toEqual({ ok: true })
  expect(probe).toHaveBeenCalledOnce()
})
