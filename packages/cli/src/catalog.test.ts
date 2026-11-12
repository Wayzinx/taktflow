import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '@taktflow/core'
import { createHarnesses } from '@taktflow/harness'
import { createRuntimeCatalog } from './catalog.js'
import type { ProjectContext } from './project.js'

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'takt-catalog-cache-'))
  dirs.push(dir)
  const stores = await initProject(dir)
  stores.config.providers = { demo: { protocol: 'openai-chat', apiKeyEnv: 'TAKT_CACHE_TEST_KEY' } }
  stores.config.models = { fast: { provider: 'demo', id: 'model' } }
  const available = vi.fn(async () => ({ ok: true }))
  const context: ProjectContext = {
    stores, workflows: [], profiles: {}, providers: {}, knowledge: [],
    plugins: { names: [], harnesses: {}, providers: {}, workflows: [], roles: {}, knowledge: [] },
    harnesses: { test: { id: 'test', displayName: 'Test', available, run: async () => ({ ok: true, finalText: '' }) } },
  }
  const load = vi.fn(async () => ({ ...context }))
  const validate = vi.fn()
  let time = 0
  let modified = 1
  const catalog = createRuntimeCatalog({ load, validate, now: () => time, mtime: async () => modified })
  return { stores, context, available, load, validate, catalog, setTime: (value: number) => { time = value }, setMtime: (value: number) => { modified = value } }
}

it('并发 models 请求只加载一次，不做 harness 校验、零探测；keyPresent 每次读取环境变量', async () => {
  const f = await fixture()
  vi.stubEnv('TAKT_CACHE_TEST_KEY', '')
  const rows = await Promise.all(Array.from({ length: 8 }, () => f.catalog.getModels(f.stores)))
  expect(rows[0]).toEqual([expect.objectContaining({ alias: 'fast', keyPresent: false })])
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.validate).not.toHaveBeenCalled()
  expect(f.available).not.toHaveBeenCalled()
  vi.stubEnv('TAKT_CACHE_TEST_KEY', 'synthetic-cache-secret')
  expect(await f.catalog.getModels(f.stores)).toEqual([expect.objectContaining({ keyPresent: true })])
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.available).not.toHaveBeenCalled()
})

it('并发 settings 和兼容 catalog 请求合并加载与尚未完成的探测', async () => {
  const f = await fixture()
  let release!: (value: { ok: boolean }) => void
  let started!: () => void
  const probing = new Promise<void>((resolve) => { started = resolve })
  f.available.mockImplementation(() => { started(); return new Promise((resolve) => { release = resolve }) })
  const requests = Promise.all([
    f.catalog.getHarnesses(f.stores), f.catalog.getModels(f.stores), f.catalog.getCatalog(f.stores),
    f.catalog.getHarnesses(f.stores), f.catalog.getModels(f.stores),
  ])
  await probing
  // models 无需等待正在进行的 harness 探测。
  expect(await f.catalog.getModels(f.stores)).toHaveLength(1)
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.validate).toHaveBeenCalledTimes(1)
  expect(f.available).toHaveBeenCalledTimes(1)
  release({ ok: true })
  await requests
  await f.catalog.getCatalog(f.stores)
  expect(f.available).toHaveBeenCalledTimes(1)
})

it('60 秒 TTL 和配置 mtime 分别使 runtime 与探测缓存失效', async () => {
  const f = await fixture()
  await f.catalog.getCatalog(f.stores)
  f.setTime(59_999)
  await f.catalog.getCatalog(f.stores)
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.available).toHaveBeenCalledTimes(1)
  f.setTime(60_000)
  await Promise.all([f.catalog.getCatalog(f.stores), f.catalog.getCatalog(f.stores)])
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.validate).toHaveBeenCalledTimes(2)
  expect(f.available).toHaveBeenCalledTimes(2)
  f.setMtime(2)
  await Promise.all([f.catalog.getCatalog(f.stores), f.catalog.getCatalog(f.stores)])
  expect(f.load).toHaveBeenCalledTimes(3)
  expect(f.validate).toHaveBeenCalledTimes(3)
  expect(f.available).toHaveBeenCalledTimes(3)
})

it('load 失败的并发请求共享失败，下次请求立即重试', async () => {
  const f = await fixture()
  f.load.mockRejectedValueOnce(new Error('load failed'))
  const results = await Promise.allSettled([f.catalog.getModels(f.stores), f.catalog.getHarnesses(f.stores)])
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.available).not.toHaveBeenCalled()
  expect(await f.catalog.getCatalog(f.stores)).toMatchObject({ harnesses: [{ available: true }] })
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.available).toHaveBeenCalledTimes(1)
})

it('validate 失败只阻断 harness 目录，models 仍可返回配置清单；下次 harness 请求立即重试校验', async () => {
  const f = await fixture()
  f.validate.mockImplementationOnce(() => { throw new Error('validate failed') })
  const results = await Promise.allSettled([f.catalog.getModels(f.stores), f.catalog.getHarnesses(f.stores)])
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(results[0]!.value).toEqual([expect.objectContaining({ alias: 'fast' })])
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.available).not.toHaveBeenCalled()
  expect(await f.catalog.getCatalog(f.stores)).toMatchObject({ harnesses: [{ available: true }] })
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.validate).toHaveBeenCalledTimes(2)
  expect(f.available).toHaveBeenCalledTimes(1)
})

it('探测抛错返回脱敏原因且不污染缓存，下一批并发请求只重试一次探测', async () => {
  const f = await fixture()
  vi.stubEnv('TAKT_CACHE_TEST_KEY', 'synthetic-cache-secret')
  f.available.mockRejectedValueOnce(new Error('probe synthetic-cache-secret failed'))
  const first = await Promise.all([f.catalog.getHarnesses(f.stores), f.catalog.getHarnesses(f.stores)])
  expect(first[0]).toEqual([expect.objectContaining({ available: false, reason: 'probe [REDACTED] failed' })])
  expect(f.available).toHaveBeenCalledTimes(1)
  const second = await Promise.all([f.catalog.getHarnesses(f.stores), f.catalog.getHarnesses(f.stores)])
  expect(second[0]).toEqual([expect.objectContaining({ available: true })])
  expect(f.available).toHaveBeenCalledTimes(2)
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.validate).toHaveBeenCalledTimes(1)
})

it('mtime 变化期间旧加载失败不会删除新版本缓存', async () => {
  const f = await fixture()
  let reject!: (error: Error) => void
  let started!: () => void
  const loading = new Promise<void>((resolve) => { started = resolve })
  f.load.mockImplementationOnce(() => { started(); return new Promise((_resolve, fail) => { reject = fail }) })
  const old = f.catalog.getModels(f.stores)
  const rejected = expect(old).rejects.toThrow('old failed')
  await loading
  f.setMtime(2)
  expect(await f.catalog.getModels(f.stores)).toHaveLength(1)
  reject(new Error('old failed'))
  await rejected
  await f.catalog.getModels(f.stores)
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.available).not.toHaveBeenCalled()
})

it('profile 仍指向停用内置项时目录仍可读取并展示重新启用入口，执行表不恢复该项', async () => {
  const f = await fixture()
  f.context.stores.config.harnessOverrides = { codex: { disabled: true } }
  f.context.profiles = { dev: { role: 'dev', title: 'dev', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'codex' } } }
  f.context.harnesses = createHarnesses({ config: f.context.stores.config })
  for (const h of Object.values(f.context.harnesses)) h.available = async () => ({ ok: true })
  const catalog = createRuntimeCatalog({ load: async () => f.context, mtime: async () => 1 })
  expect((await catalog.getHarnesses(f.stores)).find(h => h.id === 'codex')).toMatchObject({ available: false, reason: '本空间已停用', roles: ['dev'] })
  expect(f.context.harnesses.codex).toBeUndefined()
})
