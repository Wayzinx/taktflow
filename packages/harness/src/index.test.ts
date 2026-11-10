import { resolve } from 'node:path'
import type { CliHarnessConfig, ModelProvider, TaktConfig } from '@taktflow/core'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarnesses, createClaudeCodeHarness, createClaudeCodeParser, createCodexHarness, createCodexParser,
  createDshHarness, createDshParser, createMockHarness, loadMockScript, extractJsonBlock, finalizeResult, runProcess,
  createGeminiCliHarness, createGeminiCliParser, createCursorAgentHarness, createCursorAgentParser,
  createQwenCodeHarness, createQwenCodeParser, createKimiCliHarness, createKimiCliParser,
  createOpenCodeHarness, createOpenCodeParser, createCliHarness, createCliParser, inferCliCapabilities } from './index.js'

vi.mock('./process.js', async importOriginal => ({
  ...await importOriginal<typeof import('./process.js')>(), runProcess: vi.fn(),
}))
beforeEach(() => {
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcess).mockResolvedValue({ ok: true, stdout: '', stderr: '', exitCode: 0 })
  vi.stubEnv('DSH_BIN', '')
})
afterEach(() => vi.unstubAllEnvs())

const builtinIds = ['native', 'mock', 'claude-code', 'codex', 'trae', 'dsh', 'gemini-cli', 'cursor-agent', 'qwen-code', 'kimi-cli', 'opencode', 'pi']
const custom = (id: string): CliHarnessConfig => ({ id, kind: 'cli', command: ['./tools/local-cli'], output: { format: 'text' } })
const config = (...harnesses: CliHarnessConfig[]): TaktConfig => ({ project: { name: 'test' }, workflows: [], harnesses })

describe('harness exports', () => {
  it('默认包含 native 和十一个 CLI/mock 适配器，空 mock 脚本可直接使用；创建时不探测 CLI', async () => {
    const harnesses = createHarnesses()
    expect(Object.keys(harnesses)).toEqual(builtinIds)
    for (const [id, adapter] of Object.entries(harnesses)) expect(adapter.id).toBe(id)
    expect(await harnesses.mock!.run({ prompt: 'task', cwd: tmpdir() }, () => {})).toMatchObject({ ok: true, finalText: '(mock) no step matched' })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('传递 mockScript 和所有 CLI 的独立配置', async () => {
    const harnesses = createHarnesses({
      mockScript: { steps: [{ finalText: 'configured' }] },
      claudeCode: { bin: '/configured/claude' }, codex: { bin: '/configured/codex' },
      geminiCli: { bin: '/configured/gemini' }, cursorAgent: { bin: '/configured/cursor' },
      qwenCode: { bin: '/configured/qwen' }, kimiCli: { bin: '/configured/kimi' }, openCode: { bin: '/configured/opencode' },
      dsh: { bin: '/configured/dsh', probeTimeoutMs: 123 },
    })
    expect((await harnesses.mock!.run({ prompt: 'task', cwd: tmpdir() }, () => {})).finalText).toBe('configured')
    await harnesses['claude-code']!.available()
    await harnesses.codex!.available()
    await harnesses.dsh!.available()
    for (const id of ['gemini-cli', 'cursor-agent', 'qwen-code', 'kimi-cli', 'opencode']) await harnesses[id]!.available()
    expect(vi.mocked(runProcess).mock.calls.map(call => call[0])).toEqual(['/configured/claude', '/configured/codex', '/configured/dsh', '/configured/dsh', '/configured/gemini', '/configured/cursor', '/configured/qwen', '/configured/kimi', '/configured/opencode'])
    expect(vi.mocked(runProcess).mock.calls[2]?.[2].timeoutMs).toBe(123)
  })

  it('从统一出口导出所有工厂、parser、mock loader 和 process 工具', () => {
    for (const exported of [createClaudeCodeHarness, createCodexHarness, createDshHarness, createMockHarness,
      createClaudeCodeParser, createCodexParser, createDshParser, loadMockScript, extractJsonBlock, finalizeResult,
      createGeminiCliHarness, createGeminiCliParser, createCursorAgentHarness, createCursorAgentParser,
      createQwenCodeHarness, createQwenCodeParser, createKimiCliHarness, createKimiCliParser,
      createOpenCodeHarness, createOpenCodeParser, createCliHarness, createCliParser, inferCliCapabilities]) {
      expect(exported).toBeTypeOf('function')
    }
  })
})


describe('声明式 CLI 注册', () => {
  it('保留内置并注册 custom，projectDir 用于解析相对 executable', async () => {
    const projectDir = resolve(tmpdir(), 'conformance-project')
    const harnesses = createHarnesses({ config: config(custom('community')), projectDir })
    expect(Object.keys(harnesses)).toEqual([...builtinIds, 'community'])
    expect(harnesses.community!.id).toBe('community')
    expect(runProcess).not.toHaveBeenCalled()
    await harnesses.community!.run({ prompt: 'task', cwd: tmpdir() }, () => {})
    expect(vi.mocked(runProcess).mock.calls[0]?.[0]).toBe(resolve(projectDir, 'tools/local-cli'))
  })

  it.each(builtinIds)('拒绝覆盖内置 %s', id => {
    expect(() => createHarnesses({ config: config(custom(id)) })).toThrow(`重复的 harness ID: ${id}`)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('拒绝重复的自定义 ID', () => {
    expect(() => createHarnesses({ config: config(custom('community'), custom('community')) })).toThrow('重复的 harness ID: community')
  })

  it('对象原型键也是正常的独立 ID，重复仍拒绝', () => {
    const harnesses = createHarnesses({ config: config(custom('__proto__'), custom('constructor'), custom('toString')) })
    expect(Object.getPrototypeOf(harnesses)).toBe(Object.prototype)
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expect(Object.hasOwn(harnesses, id)).toBe(true)
      expect(harnesses[id]!.id).toBe(id)
      expect(() => createHarnesses({ config: config(custom(id), custom(id)) })).toThrow(`重复的 harness ID: ${id}`)
    }
  })

  it('注册 native 并接受 providers，创建时不调用 provider', () => {
    const provider: ModelProvider = { id: 'reserved', protocol: 'openai-chat', chat: vi.fn(), available: vi.fn() }
    const harnesses = createHarnesses({ config: config(), providers: { reserved: provider } })
    expect(Object.keys(harnesses)).toEqual(builtinIds)
    expect(harnesses.native?.id).toBe('native')
    expect(provider.chat).not.toHaveBeenCalled()
    expect(provider.available).not.toHaveBeenCalled()
  })
})


it('native 优先消费注入实例表，未注入时回退 config.providers', async () => {
  const { createServer } = await import('node:http')
  const requests: unknown[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'configured native' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as import('node:net').AddressInfo
    const settings: TaktConfig = { ...config(), providers: { local: { protocol: 'openai-chat', baseURL: `http://127.0.0.1:${address.port}/v1` } }, models: { small: { provider: 'local', id: 'raw-model' } } }
    const result = await createHarnesses({ config: settings }).native!.run({ prompt: 'task', cwd: tmpdir(), model: 'small' }, () => {})
    expect(result).toMatchObject({ ok: true, finalText: 'configured native', usage: { inputTokens: 5, outputTokens: 2 } })
    expect(requests).toEqual([expect.objectContaining({ model: 'raw-model' })])
    const chat = vi.fn(async () => ({ message: { role: 'assistant' as const, content: 'injected native' }, stopReason: 'end' as const }))
    const providers = { local: { id: 'local', protocol: 'custom', chat, available: async () => ({ ok: true }) } }
    expect(await createHarnesses({ config: settings, providers }).native!.run({ prompt: 'task', cwd: tmpdir(), model: 'small' }, () => {})).toMatchObject({ ok: true, finalText: 'injected native' })
    expect(chat).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(1)
    expect(await createHarnesses({ config: settings, providers: {} }).native!.available()).toMatchObject({ ok: false })
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})
