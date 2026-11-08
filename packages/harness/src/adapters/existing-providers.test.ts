import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { HarnessRequest } from '@taktflow/core'
import { createClaudeCodeHarness } from '../claude-code.js'
import { createCodexHarness } from '../codex.js'
import { createDshHarness } from '../dsh.js'
import { createMockHarness } from '../mock.js'
import { runProcess } from '../process.js'

vi.mock('../process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../process.js')>(), runProcess: vi.fn(),
}))

const req: HarnessRequest = { cwd: tmpdir(), prompt: 'test', model: 'test-model' }
const keyName = 'TAKT_ADAPTER_TEST_CREDENTIAL'
const ignore = () => {}

beforeEach(() => {
  vi.mocked(runProcess).mockReset().mockImplementation(async (bin, _args, _req, options) => {
    options?.onLine?.(bin === 'claude' ? '{"type":"result","result":"done"}' : '{"type":"turn.completed"}')
    return { ok: true, stdout: '', stderr: '', exitCode: 0 }
  })
})
afterEach(() => vi.unstubAllEnvs())

function configs(): string[] {
  const args = vi.mocked(runProcess).mock.calls[0]![1]
  return args.flatMap((value, index) => value === '-c' ? [args[index + 1]!] : [])
}

describe('existing adapter provider configuration', () => {
  it('Claude 注入连接信息和模型，密钥使用 req.env，且不修改请求或 process.env', async () => {
    vi.stubEnv(keyName, 'inherited-fake-key')
    const request: HarnessRequest = {
      ...req,
      provider: { id: 'test', protocol: 'anthropic-messages', baseURL: 'https://example.invalid/v1', apiKeyEnv: keyName },
      env: { [keyName]: 'req-fake-key', ANTHROPIC_BASE_URL: 'old', ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_MODEL: 'old', OTHER: 'kept' },
    }
    const original = structuredClone(request)
    expect((await createClaudeCodeHarness().run(request, ignore)).ok).toBe(true)
    expect(vi.mocked(runProcess).mock.calls[0]![2].env).toEqual({
      ...request.env, ANTHROPIC_BASE_URL: 'https://example.invalid/v1', ANTHROPIC_AUTH_TOKEN: 'req-fake-key', ANTHROPIC_MODEL: 'test-model',
    })
    expect(vi.mocked(runProcess).mock.calls[0]![1].join(' ')).not.toContain('req-fake-key')
    expect(request).toEqual(original)
    expect(process.env[keyName]).toBe('inherited-fake-key')
  })

  it('Claude 从 process.env 读取短密钥；省略可选连接字段时保留现有环境', async () => {
    vi.stubEnv(keyName, 'xy')
    await createClaudeCodeHarness().run({ ...req, provider: { id: 'test', protocol: 'anthropic-messages', apiKeyEnv: keyName } }, ignore)
    expect(vi.mocked(runProcess).mock.calls[0]![2].env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'xy', ANTHROPIC_MODEL: req.model })
    vi.mocked(runProcess).mockClear()
    const env = { ANTHROPIC_BASE_URL: 'https://example.invalid', OTHER: 'kept' }
    await createClaudeCodeHarness().run({ cwd: tmpdir(), prompt: '', env, provider: { id: 'local', protocol: 'anthropic-messages' } }, ignore)
    expect(vi.mocked(runProcess).mock.calls[0]![2].env).toEqual(env)
  })

  it.each(['openai-chat', 'openai-responses'])('Codex %s 配置位于 resume 前，命令只引用变量名', async protocol => {
    const request: HarnessRequest = {
      ...req, sessionId: 'previous',
      provider: { id: 'local', protocol, baseURL: 'https://example.invalid/v1', apiKeyEnv: keyName },
      env: { [keyName]: 'fake-secret-value' },
    }
    expect((await createCodexHarness().run(request, ignore)).ok).toBe(true)
    const call = vi.mocked(runProcess).mock.calls[0]!
    expect(configs()).toEqual([
      'model_provider="local"', 'model_providers.local.name="local"',
      'model_providers.local.base_url="https://example.invalid/v1"',
      `model_providers.local.env_key="${keyName}"`,
      `model_providers.local.wire_api="${protocol === 'openai-chat' ? 'chat' : 'responses'}"`,
    ])
    expect(call[1].indexOf('resume')).toBeGreaterThan(call[1].lastIndexOf('-c'))
    expect(call[1].slice(-3)).toEqual(['resume', 'previous', '-'])
    expect(call[1].join(' ')).not.toContain('fake-secret-value')
    expect(call[2]).toBe(request)
  })

  it('Codex TOML value 中的引号、反斜线和控制字符不能注入配置', async () => {
    const provider = { id: 'team_A-1', protocol: 'openai-chat', baseURL: 'https://example.invalid/"\\\n\u0001\u007f', apiKeyEnv: 'KEY."\\\t' }
    await createCodexHarness().run({ ...req, provider, env: { [provider.apiKeyEnv]: 'fake-only' } }, ignore)
    const prefix = 'model_providers.team_A-1'
    expect(configs()).toEqual([
      'model_provider="team_A-1"', `${prefix}.name="team_A-1"`,
      String.raw`${prefix}.base_url="https://example.invalid/\"\\\n\u0001\u007f"`, String.raw`${prefix}.env_key="KEY.\"\\\t"`, `${prefix}.wire_api="chat"`,
    ])
    expect(configs().some(config => /[\n\t\u0001\u007f]/.test(config))).toBe(false)
  })

  it.each(['', 'team.a', 'team/a', 'a"b', "a'b", 'a\\b', 'a b', 'a\nb', 'a\tb', 'a\u0000b', 'a\u007fb', '团队'])('Codex 拒绝特殊 provider id %j，不尝试 quoted key 转义', async id => {
    const events = vi.fn()
    const result = await createCodexHarness().run({ ...req, provider: { id, protocol: 'openai-chat' } }, events)
    expect(result).toMatchObject({ ok: false, finalText: '', error: 'Codex provider id must match /^[A-Za-z0-9_-]+$/' })
    expect(runProcess).not.toHaveBeenCalled()
    expect(events).not.toHaveBeenCalled()
  })

  it('Codex 可使用继承环境；无认证本地 provider 不产生 env_key 或 undefined', async () => {
    vi.stubEnv(keyName, 'inherited-fake-key')
    expect((await createCodexHarness().run({ ...req, provider: { id: 'local', protocol: 'openai-chat', apiKeyEnv: keyName } }, ignore)).ok).toBe(true)
    expect(configs()).toContain(`model_providers.local.env_key="${keyName}"`)
    vi.mocked(runProcess).mockClear()
    expect((await createCodexHarness().run({ ...req, provider: { id: 'local', protocol: 'openai-responses' } }, ignore)).ok).toBe(true)
    expect(configs()).toEqual(['model_provider="local"', 'model_providers.local.name="local"', 'model_providers.local.wire_api="responses"'])
  })

  it.each([
    ['claude', createClaudeCodeHarness, 'anthropic-messages'],
    ['codex', createCodexHarness, 'openai-chat'],
  ] as const)('%s 缺失密钥或显式空覆盖必须在 spawn 前失败', async (_id, create, protocol) => {
    for (const inherited of [undefined, 'inherited-fake-key']) {
      vi.stubEnv(keyName, inherited)
      const events = vi.fn()
      const result = await create().run({ ...req, env: inherited ? { [keyName]: '' } : {}, provider: { id: 'test', protocol, apiKeyEnv: keyName } }, events)
      expect(result).toMatchObject({ ok: false, finalText: '', error: expect.stringContaining(keyName) })
      expect(result.error).toContain('missing API key')
      expect(result.error).not.toContain('inherited-fake-key')
      expect(events).not.toHaveBeenCalled()
    }
    expect(runProcess).not.toHaveBeenCalled()
  })

  it.each([
    [createClaudeCodeHarness, 'openai-chat', 'anthropic-messages'],
    [createClaudeCodeHarness, 'openai-responses', 'anthropic-messages'],
    [createClaudeCodeHarness, 'gemini', 'anthropic-messages'],
    [createCodexHarness, 'anthropic-messages', 'openai-chat or openai-responses'],
    [createCodexHarness, 'gemini', 'openai-chat or openai-responses'],
  ])('不匹配协议直接返回失败', async (create, protocol, supported) => {
    const event = vi.fn()
    const result = await create().run({ ...req, provider: { id: 'wrong', protocol } }, event)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(supported) })
    expect(runProcess).not.toHaveBeenCalled()
    expect(event).not.toHaveBeenCalled()
  })

  it('未实现 customProvider 的 DSH 和 mock 不静默忽略 provider', async () => {
    for (const harness of [createDshHarness(), createMockHarness({ steps: [] })]) {
      expect(await harness.run({ ...req, provider: { id: 'test', protocol: 'openai-chat' } }, ignore))
        .toMatchObject({ ok: false, error: expect.stringContaining('does not support custom providers') })
    }
    expect(runProcess).not.toHaveBeenCalled()
  })
})

describe('existing adapter capabilities', () => {
  it.each([
    [createClaudeCodeHarness(), { providerProtocols: ['anthropic-messages'], resume: true, structuredOutput: false, toolEvents: true, usage: true, cost: true, compactionEvents: false, customProvider: true, sandbox: false, mcp: true }],
    [createCodexHarness(), { providerProtocols: ['openai-chat', 'openai-responses'], resume: true, structuredOutput: false, toolEvents: true, usage: true, cost: false, compactionEvents: false, customProvider: true, sandbox: false, mcp: true }],
    [createDshHarness(), { resume: true, structuredOutput: false, toolEvents: true, usage: true, cost: false, compactionEvents: false, customProvider: false, sandbox: false, mcp: false }],
    [createMockHarness({ steps: [] }), { resume: false, structuredOutput: false, toolEvents: true, usage: true, cost: true, compactionEvents: true, customProvider: false, sandbox: false, mcp: false }],
  ])('$id 只声明当前实现支持的能力', (harness, capabilities) => {
    expect(harness.capabilities).toEqual({ ...capabilities, toolPhases: harness.id !== 'mock', readOnly: false, modelOverride: ['claude-code', 'codex'].includes(harness.id), effortOverride: harness.id === 'codex' })
  })
})
