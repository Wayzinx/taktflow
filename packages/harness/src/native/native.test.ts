import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir, symlink, link, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, ChatResponse, HarnessEvent, HarnessRequest, ModelProvider, ModelConfig } from '@taktflow/core'
import { createNativeHarness } from './index.js'

const dirs: string[] = []
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'takt-native-')); dirs.push(dir); return dir }
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

function end(content = 'done', extra: Partial<ChatResponse> = {}): ChatResponse {
  return { message: { role: 'assistant', content }, stopReason: 'end', ...extra }
}
function tool(name: string, args: Record<string, unknown>, id = 'call'): ChatResponse {
  return { message: { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }, stopReason: 'tool_calls' }
}
function setup(responses: ChatResponse[] | ((req: ChatRequest, index: number) => Promise<ChatResponse>), models: Record<string, ModelConfig> = { alias: { provider: 'mock', id: 'raw' } }) {
  const requests: ChatRequest[] = []
  const provider: ModelProvider = { id: 'mock', protocol: 'openai-chat', available: async () => ({ ok: true }), chat: vi.fn(async (req) => {
    requests.push(structuredClone({ ...req, signal: undefined }))
    return typeof responses === 'function' ? responses(req, requests.length - 1) : responses[requests.length - 1] ?? end()
  }) }
  return { harness: createNativeHarness({ providers: { mock: provider }, models }), provider, requests }
}
async function request(cwd?: string): Promise<HarnessRequest> { return { cwd: cwd ?? await temp(), prompt: 'Complete the task', model: 'alias', tools: { writeScope: ['**'] } } }

describe('native loop', () => {
  it('does not redact ordinary environment values from file results or exact edits', async () => {
    vi.stubEnv('TOKENIZERS_PARALLELISM', 'false')
    vi.stubEnv('MONKEY_PATCH', '1')
    const cwd = await temp()
    const original = 'const enabled = false; retries = 1'
    await writeFile(join(cwd, 'source.txt'), original)
    const { harness, requests } = setup([
      tool('read_file', { path: 'source.txt' }),
      tool('edit_file', { path: 'source.txt', old_string: original, new_string: 'const enabled = true; retries = 2' }),
      end(original),
    ])
    const events: HarnessEvent[] = []
    const result = await harness.run(await request(cwd), (event) => events.push(event))
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe(original)
    expect(requests[1]?.messages.at(-1)?.content).toBe(original)
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', tool: 'read_file', output: original }))
    expect(await readFile(join(cwd, 'source.txt'), 'utf8')).toBe('const enabled = true; retries = 2')
  })

  it('grep retains matches with oversized and binary files in the search scope', async () => {
    const cwd = await temp()
    await writeFile(join(cwd, 'a.txt'), 'needle here')
    await writeFile(join(cwd, 'large.txt'), 'needle' + 'x'.repeat(1_000_001))
    await writeFile(join(cwd, 'binary.bin'), Buffer.from('needle\0binary'))
    const { harness, requests } = setup([tool('grep', { pattern: 'needle' }), end()])
    expect((await harness.run(await request(cwd), () => {})).ok).toBe(true)
    const output = requests[1]?.messages.at(-1)?.content
    expect(output).toContain('a.txt:1:needle here')
    expect(output).toContain('Skipped 2 files')
    expect(output).not.toContain('large.txt:')
    expect(output).not.toContain('binary.bin:')
  })

  it('reads, edits, lists, greps and produces schema JSON with tool pairs and events', async () => {
    const cwd = await temp()
    await writeFile(join(cwd, 'input.txt'), 'hello old')
    const { harness, requests } = setup([
      tool('read_file', { path: 'input.txt' }, 'read'),
      tool('edit_file', { path: 'input.txt', old_string: 'old', new_string: 'new' }, 'edit'),
      tool('list', {}, 'list'), tool('grep', { pattern: 'new' }, 'grep'), end('Finished'), end('{"done":true}'),
    ])
    const events: HarnessEvent[] = []
    const schema = { type: 'object', properties: { done: { type: 'boolean' } } }
    const result = await harness.run({ ...await request(cwd), resultSchema: schema }, (event) => events.push(event))
    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ done: true })
    expect(await readFile(join(cwd, 'input.txt'), 'utf8')).toBe('hello new')
    expect(requests.at(-1)?.tools).toBeUndefined()
    expect(requests.at(-1)?.responseSchema).toEqual(schema)
    expect(requests.at(-1)?.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(['read', 'edit', 'list', 'grep'])
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(4)
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(6)
  })

  it.each(['```json\n{"done":true}\n```', '{"done":true}'])('extracts final structured response %s', async (text) => {
    const { harness } = setup([end(), end(text)])
    expect((await harness.run({ ...await request(), resultSchema: { type: 'object' } }, () => {})).structured).toEqual({ done: true })
  })

  it('fails invalid JSON and truncated/error responses, retaining usage', async () => {
    for (const response of [end('partial', { stopReason: 'length' }), end('error', { stopReason: 'error' })]) {
      const { harness } = setup([response])
      const result = await harness.run(await request(), () => {})
      expect(result.ok).toBe(false)
      expect(result.error).toContain(response.stopReason)
      expect(result.usage!.inputTokens).toBeGreaterThan(0)
    }
    const { harness } = setup([end(), end('not json')])
    expect((await harness.run({ ...await request(), resultSchema: {} }, () => {})).error).toContain('valid JSON')
  })

  it('prices cached input once and accumulates usage', async () => {
    const { harness } = setup([end('done', { usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 10 } })], {
      alias: { provider: 'mock', id: 'raw', price: { input: 2, cachedInput: 0.5, output: 10 } },
    } as Parameters<typeof createNativeHarness>[0]['models'])
    const result = await harness.run(await request(), () => {})
    expect(result.usage).toEqual({ inputTokens: 100, cachedTokens: 80, outputTokens: 10, costUsd: 0.00018 })
  })

  it('compacts early results once, preserving calls, prompt and recent results', async () => {
    const cwd = await temp()
    await writeFile(join(cwd, 'big'), 'x'.repeat(5000))
    const { harness, requests } = setup(async (_req, round) => round < 10 ? tool('read_file', { path: 'big' }, `c${round}`) : end(), {
      alias: { provider: 'mock', id: 'raw', contextWindow: 100 },
    } as Parameters<typeof createNativeHarness>[0]['models'])
    const events: HarnessEvent[] = []
    expect((await harness.run(await request(cwd), (event) => events.push(event))).ok).toBe(true)
    const compactions = events.filter((event) => event.type === 'compacted')
    expect(compactions).toHaveLength(1)
    expect(compactions[0]!.record.afterTokens).toBeLessThan(compactions[0]!.record.beforeTokens)
    const messages = requests.at(-1)!.messages
    expect(messages.find((message) => message.role === 'user')!.content).toBe('Complete the task')
    expect(messages.filter((message) => message.role === 'tool')).toHaveLength(10)
    expect(messages.at(-1)!.content).toHaveLength(5000)
    for (const message of messages.filter((entry) => entry.role === 'tool')) {
      expect(messages.some((entry) => entry.toolCalls?.some((call) => call.id === message.toolCallId))).toBe(true)
    }
  })

  it('reserves call 50 for final schema and refuses more tools', async () => {
    const { harness, requests } = setup(async () => tool('list', {}))
    const result = await harness.run({ ...await request(), resultSchema: { type: 'object' } }, () => {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('50-call limit')
    expect(requests).toHaveLength(50)
    expect(requests[49]!.tools).toBeUndefined()
    expect(requests[49]!.responseSchema).toEqual({ type: 'object' })
  })

  it('can finish with JSON on the reserved last call', async () => {
    const { harness, requests } = setup(async (_req, index) => index === 49 ? end('{"ok":true}') : tool('list', {}, String(index)))
    const result = await harness.run({ ...await request(), resultSchema: {} }, () => {})
    expect(result.structured).toEqual({ ok: true })
    expect(requests).toHaveLength(50)
  })

  it('bounds providers ignoring cancellation and propagates cancellation signal', async () => {
    let signal: AbortSignal | undefined
    const { harness } = setup((req) => { signal = req.signal; return new Promise(() => {}) })
    const result = await harness.run({ ...await request(), timeoutMs: 30 }, () => {})
    expect(result.error).toContain('timed out')
    expect(signal?.aborted).toBe(true)
    const controller = new AbortController()
    const running = harness.run({ ...await request(), signal: controller.signal }, () => {})
    setTimeout(() => controller.abort(), 20)
    expect((await running).error).toContain('cancelled')
  })

  it('does not call provider when already cancelled', async () => {
    const { harness, provider } = setup([])
    const controller = new AbortController(); controller.abort()
    expect((await harness.run({ ...await request(), signal: controller.signal }, () => {})).ok).toBe(false)
    expect(provider.chat).not.toHaveBeenCalled()
  })

  it('rejects overflowing timeout values without invoking the provider', async () => {
    const { harness, provider } = setup([])
    expect((await harness.run({ ...await request(), timeoutMs: 2 ** 31 }, () => {})).error).toContain('2147483647')
    expect(provider.chat).not.toHaveBeenCalled()
  })

  it('redacts known keys in errors, tool replies, events and final JSON without changing tool input', async () => {
    const secret = 'synthetic-test-key-12345'
    vi.stubEnv('NATIVE_TEST_API_KEY', secret)
    const cwd = await temp()
    await writeFile(join(cwd, 'key.txt'), secret)
    const { harness, requests } = setup([
      tool('read_file', { path: 'key.txt' }),
      tool('edit_file', { path: 'key.txt', old_string: secret, new_string: 'removed' }),
      end(), end(JSON.stringify({ value: secret })),
    ])
    const events: HarnessEvent[] = []
    const result = await harness.run({ ...await request(cwd), resultSchema: {} }, (event) => events.push(event))
    expect(result.ok).toBe(true)
    expect(await readFile(join(cwd, 'key.txt'), 'utf8')).toBe('removed')
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(requests[1]!.messages.at(-1)!.content).toBe('[REDACTED]')
    const failing = setup(async () => { throw new Error(`401 ${secret}`) })
    expect((await failing.harness.run(await request(), () => {})).error).toBe('401 [REDACTED]')
  })

  it('redacts tool errors before feeding them back to the provider', async () => {
    const secret = 'synthetic-tool-key-67890'
    vi.stubEnv('NATIVE_TEST_API_KEY', secret)
    const { harness, requests } = setup([tool(secret, {}), end()])
    const events: HarnessEvent[] = []
    expect((await harness.run(await request(), (event) => events.push(event))).ok).toBe(true)
    expect(requests[1]!.messages.at(-1)!.content).toBe('Tool error: Unknown tool [REDACTED]')
    expect(JSON.stringify(events)).not.toContain(secret)
  })
})

describe('scope and paths', () => {
  it('fails closed without writeScope, with no mkdir side effects', async () => {
    const cwd = await temp()
    const { harness } = setup([tool('write_file', { path: 'new/child.txt', content: 'bad' }), end()])
    const events: HarnessEvent[] = []
    await harness.run({ ...await request(cwd), tools: {} }, (event) => events.push(event))
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({ ok: false, output: expect.stringContaining('writeScope') })
    await expect(access(join(cwd, 'new'))).rejects.toThrow()
  })

  it('blocks traversal, symlink escapes, internal alias bypass and hardlinks before mutation', async () => {
    const cwd = await temp(); const outside = await temp()
    await mkdir(join(cwd, 'allowed')); await mkdir(join(cwd, 'denied'))
    await writeFile(join(outside, 'target'), 'original')
    await writeFile(join(cwd, 'denied', 'target'), 'original')
    await symlink(outside, join(cwd, 'allowed', 'external'))
    await symlink(join(cwd, 'denied'), join(cwd, 'allowed', 'alias'))
    await link(join(outside, 'target'), join(cwd, 'allowed', 'hard'))
    const calls = ['../escape', join(outside, 'target'), 'allowed/external/new/sub', 'allowed/alias/new/sub', 'allowed/hard'].map((path, index) => tool('write_file', { path, content: 'bad' }, String(index)))
    const { harness } = setup([...calls, tool('read_file', { path: 'allowed/external/target' }), end()])
    const events: HarnessEvent[] = []
    await harness.run({ ...await request(cwd), tools: { writeScope: ['allowed/**'] } }, (event) => events.push(event))
    expect(events.filter((event) => event.type === 'tool_call').every((event) => !event.ok)).toBe(true)
    expect(await readFile(join(outside, 'target'), 'utf8')).toBe('original')
    await expect(access(join(cwd, 'denied', 'new'))).rejects.toThrow()
    await expect(access(join(outside, 'new'))).rejects.toThrow()
  })

  it('checks lexical scope even when symlink resolves into an allowed directory', async () => {
    const cwd = await temp(); await mkdir(join(cwd, 'allowed')); await symlink(join(cwd, 'allowed'), join(cwd, 'denied'))
    const { harness } = setup([tool('write_file', { path: 'denied/new', content: 'bad' }), end()])
    const events: HarnessEvent[] = []
    await harness.run({ ...await request(cwd), tools: { writeScope: ['allowed/**'] } }, (event) => events.push(event))
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({ ok: false })
    await expect(access(join(cwd, 'allowed', 'new'))).rejects.toThrow()
  })

  it('rejects empty, missing and overlapping ambiguous edit targets', async () => {
    const cwd = await temp(); await writeFile(join(cwd, 'file'), 'aaa')
    const { harness } = setup(['', 'absent', 'aa'].map((old_string) => tool('edit_file', { path: 'file', old_string, new_string: 'bad' })))
    const events: HarnessEvent[] = []
    await harness.run(await request(cwd), (event) => events.push(event))
    expect(events.filter((event) => event.type === 'tool_call').every((event) => !event.ok)).toBe(true)
    expect(await readFile(join(cwd, 'file'), 'utf8')).toBe('aaa')
  })

  it('does not advertise or execute bash without opt in', async () => {
    const { harness, requests } = setup([tool('bash', { command: 'touch escaped' }), end()])
    const req = await request()
    const events: HarnessEvent[] = []
    await harness.run(req, (event) => events.push(event))
    expect(requests[0]!.tools?.some((item) => item.name === 'bash')).toBe(false)
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({ ok: false, output: expect.stringContaining('disabled') })
    await expect(access(join(req.cwd, 'escaped'))).rejects.toThrow()
  })
})

describe('resume and model routing', () => {
  it('starts fresh in a new instance when a persisted session ID is passed', async () => {
    const first = setup([])
    const req = await request()
    const result = await first.harness.run(req, () => {})
    const replacement = setup([])
    expect(replacement.harness.capabilities?.resume).toBe(false)
    const next = await replacement.harness.run({ ...req, sessionId: result.sessionId, prompt: 'Continue with artifact manifest' }, () => {})
    expect(next.ok).toBe(true)
    expect(next.sessionId).not.toBe(result.sessionId)
    expect(replacement.requests[0]!.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['Continue with artifact manifest'])
  })

  it('uses explicit metadata for duplicate raw IDs without guessing an alias', async () => {
    const { harness, requests } = setup(async () => end('done', { usage: { inputTokens: 100, outputTokens: 10 } }), {
      a: { provider: 'mock', id: 'raw', price: { input: 999, output: 999 } },
      b: { provider: 'mock', id: 'raw', price: { input: 888, output: 888 } },
    })
    const req: HarnessRequest = { ...await request(), model: 'raw', provider: { id: 'mock', protocol: 'openai-chat' }, modelConfig: { price: { input: 1, output: 2 }, contextWindow: 100000 } }
    const result = await harness.run(req, () => {})
    expect(result.ok).toBe(true)
    expect(requests[0]!.model).toBe('raw')
    expect(result.usage?.costUsd).toBeCloseTo(0.00012, 10)
    const unknownPrice = await harness.run({ ...req, modelConfig: undefined } as HarnessRequest, () => {})
    expect(unknownPrice.ok).toBe(true)
    expect(unknownPrice.usage?.costUsd).toBeUndefined()
    expect((await harness.run({ ...await request(), model: 'raw' }, () => {})).error).toContain('Cannot resolve provider')
  })

  it('does not reinterpret an engine-resolved vendor ID as an unrelated alias', async () => {
    const { harness, requests } = setup([end('done', { usage: { inputTokens: 10, outputTokens: 10 } })], {
      raw: { provider: 'other', id: 'different', price: { input: 999, output: 999 } },
    })
    const result = await harness.run({ ...await request(), model: 'raw', provider: { id: 'mock', protocol: 'openai-chat' } }, () => {})
    expect(result.ok).toBe(true)
    expect(requests[0]!.model).toBe('raw')
    expect(result.usage?.costUsd).toBeUndefined()
  })

  it('creates config-based providers through the sibling factory and honors request overrides', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const harness = createNativeHarness({ providers: { local: { protocol: 'openai-chat', baseURL: 'https://unused.invalid' } }, models: {} })
    const result = await harness.run({ ...await request(), model: 'vendor-model', provider: { id: 'local', protocol: 'openai-chat', baseURL: 'https://override.invalid/api/v3' } }, () => {})
    expect(result.ok).toBe(true)
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://override.invalid/api/v3/chat/completions')
  })
})
