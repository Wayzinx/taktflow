import { expect, it, vi } from 'vitest'
import { validateStewardRuntime } from './runtime.js'
import type { StewardDeps } from './contracts.js'
import type { StewardStore } from './store.js'

const store = { prefs: async () => ({ trust: 'confirm', digestTimes: [] }) } as unknown as StewardStore
it('线程运行时校验传递 provider/effort，原始模型不受旧 choices 别名列表限制', async () => {
  const resolveRuntime = vi.fn(async () => ({}))
  const deps = { resolveRuntime, runtimeChoices: async () => [] } as unknown as StewardDeps
  const selection = { harness: 'codex', provider: 'custom', model: 'vendor/model', effort: 'high' }
  await validateStewardRuntime(selection, deps, store)
  expect(resolveRuntime).toHaveBeenCalledWith(await store.prefs(), selection)
})
it.each([{ effort: ['high'] }, { effort: 'ultra' }, { effort: 3 }, { provider: '' }, { provider: 3 }, { extra: true }, { model: false }])('线程运行时拒绝非法字段 %j', async runtime => {
  const resolveRuntime = vi.fn(async () => ({}))
  await expect(validateStewardRuntime(runtime, { resolveRuntime } as unknown as StewardDeps, store)).rejects.toMatchObject({ status: 400 })
  expect(resolveRuntime).not.toHaveBeenCalled()
})
it('线程运行时保留旧 choices 回调兼容性，解析器错误不吞掉', async () => {
  const deps = { runtimeChoices: async () => [{ harness: 'codex', model: 'alias', available: true }] } as unknown as StewardDeps
  await expect(validateStewardRuntime({ harness: 'codex', model: 'alias' }, deps, store)).resolves.toBeUndefined()
  await expect(validateStewardRuntime({ harness: 'codex', model: 'other' }, deps, store)).rejects.toMatchObject({ status: 400 })
  const error = new Error('provider 不存在')
  await expect(validateStewardRuntime({ provider: 'missing' }, { resolveRuntime: async () => { throw error } } as unknown as StewardDeps, store)).rejects.toBe(error)
})
