import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openProject, type TaktConfig, type EventPayloads } from '@taktflow/core'
import { createHarnesses } from '@taktflow/harness'
import { main } from './index.js'
import { createRunEngine, loadRuntime, resolveWorkflow, withMock } from './project.js'
import { createRuntimeCatalog, getRuntimeCatalog } from './catalog.js'

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
const empty: TaktConfig = { project: { name: 'runtime' }, workflows: [], knowledge: [] }
async function fixture(config: Partial<TaktConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'takt-runtime-'))
  dirs.push(dir)
  await mkdir(join(dir, '.takt/agents'), { recursive: true })
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await configure(dir, config)
  return dir
}
async function configure(dir: string, config: Partial<TaktConfig>) { await writeFile(join(dir, 'takt.config.json'), JSON.stringify({ ...empty, ...config })) }
async function cli(dir: string, args: string[]) {
  const output: string[] = []
  const errors: string[] = []
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((text) => { output.push(String(text)); return true })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((text) => { errors.push(String(text)); return true })
  try {
    const code = await main([...args, '--project', dir, '--json'])
    const stdout = output.join('')
    return { code, data: JSON.parse(stdout), stdout, stderr: errors.join('') }
  } finally { out.mockRestore(); err.mockRestore() }
}
const workflow = { id: 'plug-flow', title: 'Plugin workflow', version: '1', stages: [], nodes: [{ id: 'work', kind: 'agent', title: 'Work', role: 'plug-role', prompt: 'write result', writeScope: ['allowed/**'] }] }
const profile = '---\nharness:\n  harness: native\n  model: small\nwriteScope: ["allowed/**"]\n---\nUse tools.'
const providers = { local: { protocol: 'plugin-protocol' } }
const models = { small: { provider: 'local', id: 'raw-model', contextWindow: 8192, price: { input: 2, output: 4, cachedInput: 1 } } }
async function pluginProject() {
  const dir = await fixture({ plugins: ['./plugin.ts'], providers, models })
  await writeFile(join(dir, 'plugin.ts'), `
    const label: string = 'local-plugin'
    export default { name: label, apiVersion: 1,
      harnesses: [{ id: 'plugin-harness', displayName: 'Plugin', capabilities: {}, available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: 'plugin' }) }],
      providers: { 'plugin-protocol': (config) => ({ id: 'factory-id', protocol: config.protocol,
        available: async () => ({ ok: true }),
        chat: async (req) => {
          if (req.model !== 'raw-model') throw new Error('alias was not resolved')
          if (req.tools?.some(tool => tool.name === 'bash')) throw new Error('bash must default to false')
          if (!req.messages.some(message => message.role === 'tool')) return {
            message: { role: 'assistant', content: '', toolCalls: [
              { id: 'outside', name: 'write_file', arguments: JSON.stringify({ path: 'forbidden.txt', content: 'must not write' }) },
              { id: 'inside', name: 'write_file', arguments: JSON.stringify({ path: 'allowed/result.txt', content: 'plugin native executed' }) }
            ] }, stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 }
          }
          const outputs = req.messages.filter(message => message.role === 'tool')
          if (!outputs[0].content.includes('Tool error:') || outputs[1].content.includes('Tool error:')) throw new Error('tool constraints not applied')
          return { message: { role: 'assistant', content: 'plugin native completed' }, stopReason: 'end', usage: { inputTokens: 20, outputTokens: 10 } }
        }
      }) },
      knowledge: [() => ({ id: 'plugin-knowledge', kind: 'plugin', intents: ['fact'], describe: () => 'fixture', query: async () => [{ sourceId: 'plugin-knowledge', title: 'plugin fact', ref: 'fixture', snippet: 'known', score: 1 }] })],
      workflows: [${JSON.stringify(workflow)}], roles: { 'plug-role': ${JSON.stringify(profile)} }
    }
  `)
  return dir
}

it('本地 TS 插件经 CLI runtime/native 真正执行 provider 工具往返，拒绝越界且保留价格', async () => {
  const dir = await pluginProject()
  const context = await loadRuntime(dir)
  expect(context.profiles['plug-role']?.allowBash).toBe(false)
  expect(context.knowledge[0]?.id).toBe('plugin-knowledge')
  const requirement = await context.stores.workspaces.createRequirement({ title: 'integration' })
  const state = await createRunEngine(context).start({ requirementId: requirement.id, workflow: await resolveWorkflow(context, 'plug-flow') })
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  expect(await readFile(join(dir, 'allowed/result.txt'), 'utf8')).toBe('plugin native executed')
  await expect(readFile(join(dir, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(state.nodes.work?.result).toBe('plugin native completed')
  expect(state.nodes.work?.usage).toMatchObject({ inputTokens: 30, outputTokens: 15 })
  expect(state.nodes.work?.usage?.costUsd).toBeCloseTo(0.00012, 10)
  const events = await context.stores.events.read(state.runId)
  const tools = events.filter(event => event.type === 'harness.tool_call').map(event => event.data as EventPayloads['harness.tool_call'])
  const ended = tools.filter(tool => tool.phase === 'end')
  expect(ended).toHaveLength(2)
  expect(ended).toMatchObject([{ callId: 'outside', ok: false }, { callId: 'inside', ok: true }])
  expect(tools.filter(tool => tool.phase === 'start').map(tool => tool.callId)).toEqual(ended.map(tool => tool.callId))
  expect(await context.stores.events.verify(state.runId)).toEqual({ ok: true })
  expect((await cli(dir, ['kb', 'query', 'fixture', '--intent', 'fact'])).data).toEqual([expect.objectContaining({ sourceId: 'plugin-knowledge' })])
})

it('withMock 只替换 mock，保留插件/native 实例和注册表', async () => {
  const dir = await pluginProject()
  const context = await loadRuntime(dir)
  const path = join(dir, 'mock.json')
  await writeFile(path, '{"steps":[{"finalText":"replacement"}]}')
  const replaced = await withMock(context, path)
  for (const id of Object.keys(context.harnesses).filter((id) => id !== 'mock')) expect(replaced.harnesses[id]).toBe(context.harnesses[id])
  expect(replaced.harnesses.mock).not.toBe(context.harnesses.mock)
  expect(await replaced.harnesses.mock!.run({ prompt: '', cwd: dir }, () => {})).toMatchObject({ finalText: 'replacement' })
})

it('无 CLI、无 provider 时 doctor 成功且完整展示不可用原因和能力', async () => {
  const dir = await fixture()
  vi.stubEnv('PATH', '')
  vi.stubEnv('DSH_BIN', '/missing-dsh')
  const result = await cli(dir, ['doctor'])
  expect(result.code).toBe(0)
  expect(result.data.harnesses).toHaveLength(Object.keys(createHarnesses()).length)
  expect(result.data.harnesses.find((row: { id: string }) => row.id === 'native')).toMatchObject({ source: 'native', available: false, reason: expect.any(String), capabilities: { customProvider: true, requiresProvider: true }, roles: [] })
  expect(result.data.harnesses.find((row: { id: string }) => row.id === 'codex')).toMatchObject({ available: false, reason: expect.any(String) })
  expect((await cli(dir, ["harness", "ls"])).data).toHaveLength(Object.keys(createHarnesses()).length)
  expect((await cli(dir, ['models', 'ls'])).data).toEqual([])
})

it('preset 在 runtime 配置展开；默认环境变量缺失时 doctor=1；Codex responses 允许', async () => {
  const dir = await fixture({ providers: { remote: { preset: 'openai', protocol: 'openai-responses' } }, models: { chosen: { provider: 'remote', id: 'gpt-test' } }, roles: { dev: { harness: 'codex', model: 'chosen' } } })
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('PATH', '')
  const runtime = await loadRuntime(dir)
  expect(runtime.stores.config.providers?.remote).toMatchObject({ baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', protocol: 'openai-responses' })
  expect(runtime.providers).toEqual({})
  const result = await cli(dir, ['doctor'])
  expect(result.code).toBe(1)
  expect(result.data.checks).toContainEqual({ id: 'provider:remote', ok: false, reason: '缺少环境变量 OPENAI_API_KEY' })
  expect(result.data.checks).toContainEqual({ id: 'config', ok: true })
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-not-a-real-key')
  expect((await cli(dir, ['doctor'])).code).toBe(0)
})

it.each(['openai-responses', 'gemini'])('native 选择无工厂的 %s 早失败，而非仅不可用', async (protocol) => {
  const dir = await fixture({ providers: { remote: { protocol, baseURL: 'http://127.0.0.1:1' } }, roles: { dev: { harness: 'native', provider: 'remote', model: 'raw' } } })
  vi.stubEnv('PATH', '')
  const result = await cli(dir, ['doctor'])
  expect(result.code).toBe(1)
  expect(result.data.checks).toContainEqual(expect.objectContaining({ id: 'config', ok: false, reason: expect.stringContaining('不支持 provider 协议') }))
})

it.each([
  { providers: { bad: { protocol: 'not-implemented' } } },
  { models: { bad: { provider: 'missing', id: 'x' } } },
  { models: { bad: { provider: 'x', id: '' } } },
  { providers: { x: { protocol: 'openai-responses' } }, models: { bad: { provider: 'x', id: 'x', contextWindow: -1 } } },
  { providers: { x: { protocol: 'openai-responses' } }, models: { bad: { provider: 'x', id: 'x', price: { input: -1, output: 0 } } } },
  { roles: { dev: { harness: 'codex', provider: 'missing' } } },
])('doctor 配置错误返回 1，不转换成 UsageError 2：%j', async (config) => {
  const dir = await fixture(config)
  vi.stubEnv('PATH', '')
  expect((await cli(dir, ['doctor'])).code).toBe(1)
})

it.each(['module', 'factory'])('doctor %s 异常按 apiKeyEnv 脱敏', async (boundary) => {
  vi.stubEnv('TAKT_FIXTURE_SECRET', 'synthetic-provider-secret-for-redaction')
  const dir = await fixture({ providers: { test: { protocol: 'custom', apiKeyEnv: 'TAKT_FIXTURE_SECRET' } }, plugins: ['./secret.ts'] })
  await writeFile(join(dir, 'secret.ts'), boundary === 'module' ? `throw new Error('load failed ' + process.env.TAKT_FIXTURE_SECRET); export default {}` : `export default { name: 'secret', apiVersion: 1, providers: { test: () => { throw new Error('factory failed ' + process.env.TAKT_FIXTURE_SECRET) } } }`)
  const result = await cli(dir, ['doctor'])
  expect(result.code).toBe(1)
  expect(result.stdout + result.stderr).not.toContain('synthetic-provider-secret-for-redaction')
  expect(result.stdout).toContain('[REDACTED]')
})

it('角色 allowBash 保留 boolean，错误类型拒绝；本地覆盖同名插件角色', async () => {
  const dir = await fixture()
  await writeFile(join(dir, '.takt/agents/dev.md'), '---\nharness: mock\nallowBash: true\n---\nDev')
  expect((await loadRuntime(dir)).profiles.dev?.allowBash).toBe(true)
  await writeFile(join(dir, '.takt/agents/dev.md'), '---\nharness: mock\nallowBash: "false"\n---\nDev')
  await expect(loadRuntime(dir)).rejects.toThrow('allowBash')
  const other = await pluginProject()
  await writeFile(join(other, '.takt/agents/plug-role.md'), '---\nharness: mock\n---\nDuplicate')
  expect((await loadRuntime(other)).profiles['plug-role']?.instructions).toBe('Duplicate')
})

it('直接文件 workflow 的能力错误在创建 run 前失败；mock override 使用生效的选择', async () => {
  const dir = await fixture({ providers: { remote: { protocol: 'openai-responses' } } })
  await writeFile(join(dir, '.takt/agents/dev.md'), '---\nharness: dsh\n---\nDev')
  const definition = { ...workflow, nodes: [{ ...workflow.nodes[0], role: 'dev', harness: { harness: 'dsh', provider: 'remote', model: 'raw' } }] }
  await writeFile(join(dir, 'direct.ts'), `export default ${JSON.stringify(definition)}`)
  const stores = await openProject(dir)
  await stores.workspaces.createRequirement({ title: 'early failure' })
  const result = await cli(dir, ['run', './direct.ts', '--req', 'REQ-001'])
  expect(result.code).toBe(1)
  expect(result.data.error).toContain('customProvider')
  expect(await stores.runs.list()).toEqual([])
  // override 的语义由共享 selection 定义，普通无 provider 流程不能被原 dsh 可用性阻断。
  await writeFile(join(dir, 'mock-direct.ts'), `export default ${JSON.stringify({ ...definition, nodes: [{ ...definition.nodes[0], harness: undefined }] })}`)
  expect((await cli(dir, ['run', './mock-direct.ts', '--req', 'REQ-001', '--harness', 'mock'])).code).toBe(0)
})

it('getCatalog 读取最新配置，输出插件来源、角色、模型和 keyPresent', async () => {
  const dir = await pluginProject()
  vi.stubEnv('PATH', '')
  const stores = await openProject(dir)
  const first = await getRuntimeCatalog(stores)
  expect(first.harnesses.find((row) => row.id === 'plugin-harness')).toMatchObject({ source: 'plugin', available: true })
  expect(first.harnesses.find((row) => row.id === 'native')).toMatchObject({ roles: ['plug-role'] })
  expect(first.models).toEqual([expect.objectContaining({ alias: 'small', provider: 'local', keyPresent: true, contextWindow: 8192 })])
  expect(first.models[0]?.price).toEqual({ input: 2, output: 4 })
  await configure(dir, {})
  const second = await getRuntimeCatalog(stores)
  expect(second.models).toEqual([])
  expect(second.harnesses.some((row) => row.id === 'plugin-harness')).toBe(false)
})

it('命令用法错误仍返回 2，坏 JSON 配置 doctor 返回 1', async () => {
  const dir = await fixture()
  for (const args of [['doctor', 'extra'], ['harness', 'bad'], ['models', 'ls', 'extra']]) expect((await cli(dir, args)).code).toBe(2)
  await writeFile(join(dir, 'takt.config.json'), '{bad')
  expect((await cli(dir, ['doctor'])).code).toBe(1)
})


it.each([
  { id: 'bad', title: '', version: '1', nodes: [] },
  { id: 'bad', title: '', version: '', stages: [], nodes: [] },
  { id: 'bad', title: '', version: '1', stages: [], nodes: [{ id: 'a', kind: 'human', title: '', ask: '', form: 'approve', needs: ['missing'] }] },
  { id: 'bad', title: '', version: '1', stages: [], nodes: [{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }] },
])('插件与文件 workflow 坏结构/DAG 在 doctor 与执行前失败：%j', async (definition) => {
  const dir = await fixture({ plugins: ['./bad.ts'] })
  await writeFile(join(dir, 'bad.ts'), `export default { name: 'bad', apiVersion: 1, workflows: [${JSON.stringify(definition)}] }`)
  expect((await cli(dir, ['doctor'])).code).toBe(1)
  await configure(dir, { workflows: ['./bad-workflow.ts'] })
  await writeFile(join(dir, 'bad-workflow.ts'), `export default ${JSON.stringify(definition)}`)
  expect((await cli(dir, ['doctor'])).code).toBe(1)
})

it('允许空 workflow title；server getCatalog 回调使用运行时插件且重新读取配置', async () => {
  const { createServer } = await import('@taktflow/server')
  const dir = await fixture({ plugins: ['./empty.ts'] })
  await writeFile(join(dir, 'empty.ts'), `export default { name: 'empty', apiVersion: 1, workflows: [{ id: 'empty', title: '', version: '1', stages: [], nodes: [] }], harnesses: [{ id: 'live-plugin', displayName: 'Live', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '' }) }] }`)
  vi.stubEnv('PATH', '')
  const options: Parameters<typeof createServer>[0] = { projectDir: dir, host: '127.0.0.1', port: 0, getCatalog: getRuntimeCatalog }
  const server = await createServer(options)
  try {
    const first = await fetch(`${server.url}/api/harnesses`)
    expect(first.status).toBe(200)
    expect(await first.json()).toContainEqual(expect.objectContaining({ id: 'live-plugin', source: 'plugin', available: true }))
    await configure(dir, {})
    const second = await fetch(`${server.url}/api/harnesses`)
    expect(await second.json()).not.toContainEqual(expect.objectContaining({ id: 'live-plugin' }))
  } finally { await server.close() }
})


it('角色空 description/title/role 保持 core loadProfiles 的兼容回退', async () => {
  const dir = await fixture()
  await writeFile(join(dir, '.takt/agents/dev.md'), '---\nrole: ""\ntitle: ""\ndescription: ""\nharness: mock\n---\nDev')
  expect((await loadRuntime(dir)).profiles.dev).toMatchObject({ role: 'dev', title: 'dev', description: '', allowBash: false })
  await writeFile(join(dir, '.takt/agents/dev.md'), '---\nrole: renamed\ntitle: ""\ndescription: ""\nharness: mock\n---\nDev')
  expect((await loadRuntime(dir)).profiles.renamed).toMatchObject({ role: 'renamed', title: 'renamed', description: '' })
})

it('models ls 与独立 models HTTP 回调均不调用 harness/provider available', async () => {
  vi.stubEnv('PATH', '')
  vi.stubEnv('DSH_BIN', '/missing-dsh')
  const { createServer } = await import('@taktflow/server')
  const dir = await fixture({
    plugins: ['./no-probe.ts'], providers: { demo: { protocol: 'plugin-protocol' } },
    models: { fast: { provider: 'demo', id: 'fast' } },
  })
  const probeFile = join(dir, 'unexpected-probe')
  await writeFile(join(dir, 'no-probe.ts'), `
    import { writeFile } from 'node:fs/promises'
    const available = async () => { await writeFile(${JSON.stringify(probeFile)}, 'probed'); return { ok: true } }
    export default { name: 'no-probe', apiVersion: 1,
      harnesses: [{ id: 'no-probe', displayName: 'No probe', available, run: async () => ({ ok: true, finalText: '' }) }],
      providers: { 'plugin-protocol': config => ({ id: 'demo', protocol: config.protocol, available, chat: async () => ({ message: { role: 'assistant', content: '' }, stopReason: 'end' }) }) }
    }
  `)
  expect((await cli(dir, ['models', 'ls'])).data).toEqual([expect.objectContaining({ alias: 'fast' })])
  const server = await createServer({ projectDir: dir, port: 0, ...createRuntimeCatalog() })
  try {
    const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(`${server.url}/api/models`)))
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([expect.objectContaining({ alias: 'fast' })])
    }
    await expect(readFile(probeFile)).rejects.toMatchObject({ code: 'ENOENT' })
    const harnesses = await fetch(`${server.url}/api/harnesses`)
    expect(harnesses.status).toBe(200)
    expect(await readFile(probeFile, 'utf8')).toBe('probed')
  } finally { await server.close() }
})

it('requiresProvider 插件可自行消费连接配置，无需 CLI ModelProvider 实例', async () => {
  const definition = { ...workflow, nodes: [{ ...workflow.nodes[0], role: 'direct', harness: { harness: 'direct-provider', model: 'direct-model' } }] }
  const dir = await fixture({
    plugins: ['./direct-provider.ts'],
    providers: { remote: { protocol: 'openai-responses', baseURL: 'http://127.0.0.1:1/v1' } },
    models: { 'direct-model': { provider: 'remote', id: 'raw-direct' } },
  })
  await writeFile(join(dir, 'direct-provider.ts'), `export default {
    name: 'direct-provider', apiVersion: 1,
    harnesses: [{ id: 'direct-provider', displayName: 'Direct provider',
      capabilities: { customProvider: true, requiresProvider: true, providerProtocols: ['openai-responses'] },
      available: async () => ({ ok: true }),
      run: async req => {
        if (req.provider?.id !== 'remote' || req.provider.protocol !== 'openai-responses' || req.provider.baseURL !== 'http://127.0.0.1:1/v1' || req.model !== 'raw-direct') throw new Error('connection config was not forwarded')
        return { ok: true, finalText: 'consumed provider config' }
      }
    }],
    roles: { direct: ${JSON.stringify('---\nharness:\n  harness: direct-provider\n  model: direct-model\n---\nDirect')} },
    workflows: [${JSON.stringify(definition)}]
  }`)
  vi.stubEnv('PATH', '')
  const context = await loadRuntime(dir)
  expect(context.providers).toEqual({})
  expect((await cli(dir, ['doctor'])).data.checks).toContainEqual({ id: 'config', ok: true })
  const requirement = await context.stores.workspaces.createRequirement({ title: 'direct provider config' })
  const state = await createRunEngine(context).start({ requirementId: requirement.id, workflow: await resolveWorkflow(context, 'plug-flow') })
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  expect(state.nodes.work?.result).toBe('consumed provider config')
})

it('takt retry 支持多个 --node，继承 mock 配置并前台等待到结束', async () => {
  const dir = await fixture()
  await writeFile(join(dir, 'retry.workflow.ts'), `export default { id: 'retry', title: '重试', version: '1', stages: [], nodes: [
    { id: 'a', kind: 'agent', title: '执行 A', role: 'worker', prompt: '执行' },
    { id: 'b', kind: 'agent', title: '执行 B', role: 'worker', prompt: '执行', needs: ['a'] }
  ] }`)
  await writeFile(join(dir, '.takt/agents/worker.md'), '---\nharness: mock\nwriteScope: []\n---\n执行')
  const mock = join(dir, 'mock.json')
  await writeFile(mock, JSON.stringify({ steps: [{ match: { nodeId: 'a' }, fail: '初次失败' }, { match: { nodeId: 'b' }, fail: '初次失败' }] }))
  const context = await loadRuntime(dir)
  const req = await context.stores.workspaces.createRequirement({ title: 'CLI 重试' })
  const first = await cli(dir, ['run', './retry.workflow.ts', '--req', req.id, '--harness', 'mock', '--mock', mock])
  expect(first.code).toBe(1)
  const failed = (await context.stores.runs.get(first.data.runId))!
  failed.nodes.b!.status = 'failed'
  await context.stores.runs.save(failed)
  await writeFile(mock, JSON.stringify({ steps: [{ finalText: '成功' }] }))
  const result = await cli(dir, ['retry', failed.runId, '--node', 'a', '--node', 'b', '--reason', '已修复'])
  expect(result.code, result.stdout).toBe(0)
  expect(result.data.status).toBe('succeeded')
  expect(result.data.nodes.a.attempts).toBe(2)
  expect(result.data.nodes.b.attempts).toBe(1)
  expect(await context.stores.events.read(failed.runId, { types: ['run.retried'] })).toMatchObject([{ actor: { type: 'human' }, data: { nodeIds: ['a', 'b'], reason: '已修复' } }])
})
