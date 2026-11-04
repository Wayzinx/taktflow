import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, type HarnessInfo, type ModelInfo, type TaktConfig } from '@taktflow/core'
import { createServer, type ServerOptions } from './index.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(callbacks: Pick<ServerOptions, 'getCatalog' | 'getHarnesses' | 'getModels'> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-catalog-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const stores = await initProject(root)
  const server = await createServer({ projectDir: root, port: 0, ...callbacks })
  cleanups.push(() => server.close())
  const configure = (config: Partial<TaktConfig>) => writeFile(join(root, 'takt.config.json'), JSON.stringify({ project: { name: '目录测试' }, workflows: [], ...config }))
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(server.url + path)
    expect(response.status).toBe(200)
    return response.json() as Promise<T>
  }
  return { root, stores, server, configure, get }
}

it('注入 runtime catalog 返回实际能力、插件来源、默认角色，并按请求传入最新 stores', async () => {
  vi.stubEnv('TAKT_CATALOG_TEST_KEY', 'synthetic-catalog-secret')
  const runtimeHarnesses: HarnessInfo[] = [
    { id: 'plugin-agent', displayName: '插件代理', source: 'plugin', available: true, capabilities: { usage: true, resume: true, structuredOutput: true }, roles: ['reviewer'] },
    { id: 'native', displayName: 'Native', source: 'native', available: true, capabilities: { toolEvents: true }, roles: ['judge'] },
    { id: 'codex', displayName: 'Codex', source: 'builtin', available: false, reason: '未安装', capabilities: { customProvider: true }, roles: [] },
  ]
  const getCatalog = vi.fn<NonNullable<ServerOptions['getCatalog']>>(async (stores) => ({
    harnesses: runtimeHarnesses,
    models: Object.entries(stores.config.models ?? {}).map(([alias, model]) => ({ alias, provider: model.provider, protocol: 'openai-chat', id: model.id, keyPresent: !!process.env.TAKT_CATALOG_TEST_KEY })),
  }))
  const { root, configure, get } = await fixture({ getCatalog })
  await configure({ plugins: ['./plugin.ts'], models: { fast: { provider: 'demo', id: 'first' } }, providers: { demo: { protocol: 'openai-chat', apiKeyEnv: 'TAKT_CATALOG_TEST_KEY' } } })
  expect(await get<HarnessInfo[]>('/api/harnesses')).toEqual(runtimeHarnesses)
  const models = await get<ModelInfo[]>('/api/models')
  expect(models).toEqual([{ alias: 'fast', provider: 'demo', protocol: 'openai-chat', id: 'first', keyPresent: true }])
  expect(JSON.stringify(models)).not.toContain('synthetic-catalog-secret')
  expect(JSON.stringify(await get('/api/harnesses'))).not.toContain('synthetic-catalog-secret')
  expect(getCatalog.mock.calls[0]![0]).toMatchObject({ projectDir: root, config: { plugins: ['./plugin.ts'] } })
  await configure({ models: { fast: { provider: 'demo', id: 'second' } } })
  expect(await get<ModelInfo[]>('/api/models')).toEqual([{ alias: 'fast', provider: 'demo', protocol: 'openai-chat', id: 'second', keyPresent: true }])
})

it('未注入目录回调时两个端点都返回 501 ApiError，不从配置推导目录', async () => {
  const { server, configure } = await fixture()
  await configure({
    harnesses: [{ id: 'configured', kind: 'cli', command: [process.execPath], output: { format: 'text' } }],
    providers: { demo: { protocol: 'openai-chat' } },
    models: { fast: { provider: 'demo', id: 'fast' } },
  })
  for (const path of ['/api/harnesses', '/api/models']) {
    const response = await fetch(server.url + path)
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ error: expect.stringContaining('未接入运行时') })
  }
})

it('独立目录回调优先于兼容回调，models 请求不进入 harness 回调', async () => {
  const getHarnesses = vi.fn(async () => [])
  const getModels = vi.fn(async () => [])
  const getCatalog = vi.fn(async () => ({ harnesses: [], models: [] }))
  const { get } = await fixture({ getHarnesses, getModels, getCatalog })
  expect(await get('/api/models')).toEqual([])
  expect(getModels).toHaveBeenCalledTimes(1)
  expect(getHarnesses).not.toHaveBeenCalled()
  expect(getCatalog).not.toHaveBeenCalled()
  expect(await get('/api/harnesses')).toEqual([])
  expect(getHarnesses).toHaveBeenCalledTimes(1)
  expect(getCatalog).not.toHaveBeenCalled()
})

it('runtime catalog 失败时返回错误，不回退成另一套可用性结果', async () => {
  const { server } = await fixture({ getCatalog: async () => { throw new Error('runtime unavailable') } })
  for (const path of ['/api/harnesses', '/api/models']) {
    const response = await fetch(server.url + path)
    expect(response.status).toBe(500)
  }
})
