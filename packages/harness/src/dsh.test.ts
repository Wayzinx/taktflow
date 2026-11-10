import { readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, HarnessRequest } from '@taktflow/core'
import { createDshHarness, createDshParser } from './dsh.js'
import { runProcess } from './process.js'
import type { ProcessResult } from './process.js'

vi.mock('./process.js', async importOriginal => ({
  ...await importOriginal<typeof import('./process.js')>(), runProcess: vi.fn(),
}))

// 根据已安装 0.2.1-rc.3 ASAR 的 json-stream/index 源码事件形状构造，非真实模型运行录制。
const fixture = `{"type":"session","sessionId":"dsh-s","cwd":"/tmp"}
{"type":"thinking","text":"内部思考"}
{"type":"text","text":"截断的正文"}
{"type":"tool_call","callId":"c1","tool":"read","input":{"path":"a"}}
{"type":"tool_call","callId":"c2","tool":"shell","input":{"command":"false"}}
{"type":"tool_result","callId":"c2","status":"error","result":{"message":"exit 1"}}
{"type":"tool_result","callId":"c1","status":"completed","result":"source body"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":40}}
{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":130,"outputTokens":30,"cacheReadTokens":60}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"完整最终回答"}`

// 2026-11-04本机手工探测录制，标识/文本脱敏且省略无关字段。
const recordedFixture = `{"type":"session","sessionId":"recorded-id"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"Sign in","code":"ACCOUNT_SIGN_IN_REQUIRED"}}}
{"type":"final","text":"[recorded text omitted]"}`

// 以下登录错误及其他边界输入为合成样例。
const loginError = '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"ACCOUNT_SIGN_IN_REQUIRED","message":"Sign in to DeepSeek to use the account provider."}}}'
const req: HarnessRequest = { prompt: 'task $HOME `literal`', cwd: tmpdir() }
const success: ProcessResult = { ok: true, stdout: '', stderr: '', exitCode: 0 }
const missing: ProcessResult = { ok: false, stdout: '', stderr: '', error: 'spawn ENOENT', spawnErrorCode: 'ENOENT' }
const appBin = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

function mockOutput(output: string, proc: Partial<ProcessResult> = {}) {
  vi.mocked(runProcess).mockImplementation(async (_bin, _args, _req, options) => {
    output.split('\n').forEach(line => options?.onLine?.(line))
    return { ...success, stdout: output, ...proc }
  })
}

beforeEach(() => {
  vi.mocked(runProcess).mockReset()
  vi.stubEnv('DSH_BIN', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('DSH parser', () => {
  it('回放本机录制：嵌套登录错误后 final 仍失败，缺失 step usage 不编造用量', async () => {
    const parser = createDshParser()
    recordedFixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toMatchObject({ ok: false, sessionId: 'recorded-id', finalText: '[recorded text omitted]' })
    expect(parser.result().error).toContain('ACCOUNT_SIGN_IN_REQUIRED')
    expect(parser.result().error).toContain('Sign in')
    expect(parser.result().usage).toBeUndefined()
    mockOutput(recordedFixture, { ok: false, exitCode: 1,
      error: 'Sign in ACCOUNT_SIGN_IN_REQUIRED ACCOUNT_SIGN_IN_REQUIRED Sign in', stderr: 'ACCOUNT_SIGN_IN_REQUIRED Sign in' })
    expect(await createDshHarness().run(req, () => {})).toMatchObject({ ok: false, exitCode: 1 })
  })

  it('损坏 error 事件记为失败和 message，后续 final 不能洗白', () => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    parser.onLine('{"type":"error","message":"permission denied"')
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toMatchObject({ ok: false, finalText: '完整最终回答' })
    expect(parser.result().error).toContain('Malformed protocol JSON')
    expect(parser.result().error).toContain('permission denied')
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', role: 'system', text: expect.stringContaining('permission denied') }))
  })

  it('读取真实事件形状，按 callId 关联工具，final 修复 text 截断，累计 step 用量', () => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toEqual({ ok: true, finalText: '完整最终回答', sessionId: 'dsh-s',
      usage: { inputTokens: 230, outputTokens: 50, cachedTokens: 100 } })
    expect(events).toContainEqual({ type: 'started', sessionId: 'dsh-s', model: undefined })
    expect(events).toContainEqual({ type: 'message', role: 'system', text: '内部思考' })
    expect(events).toContainEqual({ type: 'tool_call', phase: 'end', callId: expect.any(String), durationMs: expect.any(Number), tool: 'shell', input: '{"command":"false"}', output: '{"message":"exit 1"}', ok: false })
    expect(events).toContainEqual({ type: 'tool_call', phase: 'end', callId: expect.any(String), durationMs: expect.any(Number), tool: 'read', input: '{"path":"a"}', output: 'source body', ok: true })
    expect(events.filter(event => event.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 } },
      { type: 'usage', usage: { inputTokens: 130, outputTokens: 30, cachedTokens: 60 } },
    ])
  })

  it.each([
    loginError,
    '{"type":"error","message":"503 overloaded","code":503}',
    '{"type":"status","phase":"turn_end","reason":{"kind":"error","error":{"code":429,"message":"rate limit"}}}',
  ])('错误后 final 只能更新文本，不能洗白: %s', error => {
    const parser = createDshParser()
    parser.onLine(error)
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toMatchObject({ ok: false, finalText: '完整最终回答' })
    expect(parser.result().error).toMatch(/ACCOUNT_SIGN_IN_REQUIRED|503|429/)
  })

  it('没有 final 时拼接 text，忽略 thinking/未知/坏 JSON 的最终文本影响', () => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    for (const line of [
      '{"type":"text","text":"一"}', '{"type":"text","text":"二"}', '{"type":"thinking","text":"thought"}',
      '{"type":"future","text":"unknown"}', '{broken', 'null', '[]', '"raw"', '',
      '{"type":"tool_result","callId":"orphan","status":"completed","result":"x"}',
    ]) parser.onLine(line)
    expect(parser.result().finalText).toBe('一二')
    expect(events).toContainEqual({ type: 'message', role: 'system', text: '{broken' })
    expect(events).toContainEqual({ type: 'message', role: 'system', text: '{"type":"future","text":"unknown"}' })
    expect(events.some(event => event.type === 'message' && event.text.includes('orphan'))).toBe(true)
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(0)
  })

  it('最后 final 优先，后续 text 和未知事件不能覆盖完整答案', () => {
    const parser = createDshParser()
    for (const event of [
      { type: 'final', text: 'first' }, { type: 'final', text: 'last' }, { type: 'text', text: 'fragment' },
      { type: 'new', text: 'unknown' },
    ]) parser.onLine(JSON.stringify(event))
    expect(parser.result().finalText).toBe('last')
  })

  it.each(['step_start', 'turn_start'])('无 final 多步输出只取最后助手消息，%s 开始后逐片拼接', phase => {
    const parser = createDshParser()
    parser.onLine('{"type":"text","text":"上步答案"}')
    parser.onLine(JSON.stringify({ type: 'status', phase, turn: 1, step: 2 }))
    expect(parser.result().finalText).toBe('上步答案')
    parser.onLine('{"type":"text","text":"本步"}')
    parser.onLine('{"type":"text","text":"答案"}')
    expect(parser.result().finalText).toBe('本步答案')
    parser.onLine('{"type":"final","text":"完整答案"}')
    parser.onLine(JSON.stringify({ type: 'status', phase, turn: 1, step: 3 }))
    parser.onLine('{"type":"text","text":"片段"}')
    expect(parser.result().finalText).toBe('完整答案')
  })

  it.each([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
    { type: 'message', role: 'assistant', content: 'answer' },
    { type: 'message', message: { role: 'assistant', content: 'answer' } },
    { type: 'assistant', text: 'answer' },
    { type: 'assistant', message: 'answer' },
    { type: 'assistant', content: [{ type: 'text', text: 'ans' }, { type: 'thinking', text: 'hidden' }, { type: 'text', text: 'wer' }] },
  ])('兼容常见助手消息结构: %j', data => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    parser.onLine('{"type":"text","text":"old"}')
    parser.onLine(JSON.stringify(data))
    parser.onLine('{"type":"message","role":"user","content":"user"}')
    parser.onLine('{"type":"future","message":{"role":"assistant","content":"unknown"}}')
    expect(parser.result().finalText).toBe('answer')
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: 'answer' })
    parser.onLine('{"type":"final","text":"final"}')
    parser.onLine(JSON.stringify(data))
    expect(parser.result().finalText).toBe('final')
  })

  it.each(['s', { id: 's' }, { sessionId: 's' }, { session_id: 's' }])('兼容 session 字符串和对象: %j', session => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    parser.onLine(JSON.stringify({ type: 'session', session }))
    parser.onLine(JSON.stringify({ type: 'assistant', session, text: 'answer' }))
    expect(parser.result()).toMatchObject({ sessionId: 's', finalText: 'answer' })
    expect(events.filter(event => event.type === 'started')).toHaveLength(1)
  })

  it.each([
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 } },
    { type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3 } },
    { type: 'usage', input_tokens: 10, output_tokens: 2, cached_input_tokens: 3 },
  ])('独立 camel/snake usage 是快照，不与 step 用量重复累计: %j', data => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    parser.onLine(JSON.stringify(data))
    expect(parser.result().usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedTokens: 3 })
    expect(events).toContainEqual({ type: 'usage', usage: parser.result().usage })
    parser.onLine('{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":3}}')
    expect(parser.result().usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedTokens: 3 })
    parser.onLine('{"type":"status","phase":"step_end","turn":1,"step":2}')
    parser.onLine(JSON.stringify(data))
    expect(parser.result().usage).toBeUndefined()
  })

  it.each([
    { step: 2 },
    { step: 2, usage: { inputTokens: 20 } },
    { step: 2, usage: { inputTokens: '20', outputTokens: 2 } },
    { step: 2, usage: { inputTokens: -1, outputTokens: 2 } },
    { step: 3, usage: { inputTokens: 20, outputTokens: 2 } },
  ])('发现缺失 step/usage 时不返回完整总量，但保留已知 usage 事件: %j', missingStep => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    parser.onLine('{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":10,"outputTokens":1}}')
    parser.onLine(JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, ...missingStep }))
    expect(parser.result().usage).toBeUndefined()
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } })
  })

  it('按 turn/step 去重，不重复计费，新 turn 的 step 从头计数', () => {
    const events: HarnessEvent[] = []
    const parser = createDshParser(event => events.push(event))
    const first = { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 } }
    parser.onLine(JSON.stringify(first))
    parser.onLine(JSON.stringify(first))
    parser.onLine(JSON.stringify({ ...first, turn: 2 }))
    expect(parser.result().usage).toEqual({ inputTokens: 20, outputTokens: 4, cachedTokens: 0 })
    expect(events.filter(event => event.type === 'usage')).toHaveLength(2)
  })

  it('已开始却未报告 step_end 的 step 不计作完整总量，结束后才恢复总量', () => {
    const parser = createDshParser()
    parser.onLine('{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":10,"outputTokens":2}}')
    parser.onLine('{"type":"status","phase":"step_start","turn":1,"step":2}')
    parser.onLine('{"type":"final","text":"partial"}')
    expect(parser.result().usage).toBeUndefined()
    parser.onLine('{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":20,"outputTokens":3}}')
    expect(parser.result().usage).toEqual({ inputTokens: 30, outputTokens: 5 })
  })

  it('从未报告 usage 时不编造零用量，后续缺省缓存字段仍保留已报告缓存', () => {
    const parser = createDshParser()
    expect(parser.result().usage).toBeUndefined()
    parser.onLine('{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":1,"outputTokens":0,"cacheReadTokens":1}}')
    parser.onLine('{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":2,"outputTokens":0}}')
    expect(parser.result().usage).toEqual({ inputTokens: 3, outputTokens: 0, cachedTokens: 1 })
  })
})

describe('DSH launch and fallback', () => {
  it.each([
    ['darwin', ['/configured/dsh', 'dsh', appBin]],
    ['linux', ['/configured/dsh', 'dsh']],
  ] as const)('%s 平台只尝试对应的可执行文件候选', async (platform, candidates) => {
    vi.resetModules()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    let createForPlatform: typeof createDshHarness
    try {
      ;({ createDshHarness: createForPlatform } = await import('./dsh.js'))
    } finally {
      platformSpy.mockRestore()
    }
    vi.stubEnv('DSH_BIN', '/configured/dsh')
    vi.mocked(runProcess).mockResolvedValue(missing)
    expect((await createForPlatform().run(req, () => {})).ok).toBe(false)
    expect(vi.mocked(runProcess).mock.calls.map(call => call[0])).toEqual(candidates)
    vi.resetModules()
  })

  it('使用 headless/json/session-id/stdin，model 和 effort 通过临时 patch 覆盖', async () => {
    mockOutput(fixture)
    const request = { ...req, model: 'chosen', effort: 'high' as const, sessionId: 'old', systemAppend: 'role' }
    let path = ''
    vi.mocked(runProcess).mockImplementationOnce(async (_bin, args, _req, options) => {
      path = args[args.indexOf('--patch') + 1]!
      expect(JSON.parse(await readFile(path, 'utf8'))[0].config).toEqual({ provider: 'deepseek-account', model: 'chosen', reasoningEffort: 'high' })
      expect(args).toEqual(['--profile', 'headless', '--patch', path, '--json', '--session-id', 'old', '-'])
      expect(options?.stdin).toBe(`role\n\n${req.prompt}`)
      fixture.split('\n').forEach(line => options?.onLine?.(line))
      return success
    })
    expect((await createDshHarness({ bin: '/custom/dsh' }).run(request, () => {})).ok).toBe(true)
    await expect(access(path)).rejects.toThrow()
  })

  it('provider 子进程超时后清理临时 patch，不泄露密钥', async () => {
    let path = ''
    vi.mocked(runProcess).mockImplementationOnce(async (_bin, args) => {
      path = args[args.indexOf('--patch') + 1]!
      expect(await readFile(path, 'utf8')).not.toContain('synthetic-timeout-key')
      return { ...success, ok: false, error: 'timeout' }
    })
    const result = await createDshHarness().run({ ...req, model: 'm', provider: { id: 'p', protocol: 'openai-chat', baseURL: 'https://provider.example/v1', apiKeyEnv: 'TEST_KEY' }, env: { TEST_KEY: 'synthetic-timeout-key' } }, () => {})
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('timeout') })
    await expect(access(path)).rejects.toThrow()
  })

  it('req.env.DSH_BIN 覆盖 process.env，仅在 macOS 按 PATH、app 顺序回退', async () => {
    vi.stubEnv('DSH_BIN', '/process/dsh')
    mockOutput(fixture)
    vi.mocked(runProcess).mockResolvedValueOnce(missing)
    if (process.platform === 'darwin') vi.mocked(runProcess).mockResolvedValueOnce(missing)
    expect((await createDshHarness().run({ ...req, env: { DSH_BIN: '/request/dsh' } }, () => {})).ok).toBe(true)
    expect(vi.mocked(runProcess).mock.calls.map(call => call[0])).toEqual([
      '/request/dsh', 'dsh', ...(process.platform === 'darwin' ? [appBin] : []),
    ])
  })

  it('未覆盖时使用 process.env.DSH_BIN；新会话没有 session-id', async () => {
    vi.stubEnv('DSH_BIN', '/process/dsh')
    mockOutput(fixture)
    await createDshHarness().run(req, () => {})
    expect(runProcess).toHaveBeenCalledWith('/process/dsh', ['--profile', 'headless', '--json', '-'], req,
      { stdin: req.prompt, onLine: expect.any(Function) })
  })

  it('没有 DSH_BIN 时优先 PATH dsh，所有候选 ENOENT 返回最后失败', async () => {
    vi.mocked(runProcess).mockResolvedValue(missing)
    expect(await createDshHarness().run(req, () => {})).toMatchObject({ ok: false, error: 'spawn ENOENT' })
    expect(vi.mocked(runProcess).mock.calls.map(call => call[0])).toEqual([
      'dsh', ...(process.platform === 'darwin' ? [appBin] : []),
    ])
  })

  it.each([
    { ok: false, error: 'EACCES', spawnErrorCode: 'EACCES' },
    { ok: false, error: 'timeout' },
    { ok: false, error: 'business ENOENT in output', exitCode: 1 },
  ])('非 spawn ENOENT 不回退: %j', async failure => {
    vi.mocked(runProcess).mockResolvedValue({ ...success, ...failure })
    expect((await createDshHarness().run(req, () => {})).ok).toBe(false)
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('进程成功但事件报告登录失败时不回退，也不丢最终回答', async () => {
    mockOutput(`${loginError}\n{"type":"final","text":"partial"}`)
    const result = await createDshHarness().run(req, () => {})
    expect(result).toMatchObject({ ok: false, finalText: 'partial' })
    expect(result.error).toContain('ACCOUNT_SIGN_IN_REQUIRED')
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('合并错误和 stderr，保留 exitCode/transcript', async () => {
    mockOutput(loginError, { ok: false, error: 'timeout\n503 overloaded', stderr: '503 overloaded', exitCode: 2, transcriptPath: '/tmp/dsh.jsonl' })
    const result = await createDshHarness().run(req, () => {})
    expect(result).toMatchObject({ ok: false, exitCode: 2, transcriptPath: '/tmp/dsh.jsonl' })
    expect(result.error).toContain('ACCOUNT_SIGN_IN_REQUIRED')
    expect(result.error).toContain('timeout')
    expect(result.error).toContain('503 overloaded')
  })

  it.each([
    ['```json\n{"n":1}\n```\n```json\n{"n":2}\n```', { n: 2 }],
    ['```json\n{"n":1}\n```\n```json\nbad\n```', undefined],
    ['no json', undefined],
  ])('使用 final 完整文本做 schema 提取: %s', async (answer, structured) => {
    mockOutput(`{"type":"text","text":"truncated"}\n${JSON.stringify({ type: 'final', text: answer })}`)
    const adapter = createDshHarness()
    expect(await adapter.run({ ...req, resultSchema: {} }, () => {})).toMatchObject({ ok: true, structured })
    expect(await adapter.run(req, () => {})).not.toHaveProperty('structured')
  })
})

describe('DSH availability', () => {
  it('版本探测和独立账号就绪状态缓存 10 分钟，并发只运行一次', async () => {
    vi.useFakeTimers()
    mockOutput(fixture)
    const adapter = createDshHarness({ probeTimeoutMs: 37 })
    expect(await Promise.all([adapter.available(), adapter.available()])).toEqual([{ ok: true, ownReady: true }, { ok: true, ownReady: true }])
    expect(runProcess).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runProcess).mock.calls[0]?.[1]).toEqual(['--version'])
    vi.advanceTimersByTime(10 * 60_000 - 1)
    await adapter.available()
    expect(runProcess).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    await adapter.available()
    expect(runProcess).toHaveBeenCalledTimes(4)
  })

  it.each(['event', 'stderr', 'timeout'])('账号 %s 失败不挡住外部 API，可执行文件仍可用', async kind => {
    mockOutput(kind === 'event' ? loginError : '', kind === 'event' ? {} : { ok: false, error: kind === 'stderr' ? 'ACCOUNT_SIGN_IN_REQUIRED' : 'timeout' })
    vi.mocked(runProcess).mockResolvedValueOnce(success)
    const adapter = createDshHarness()
    const expected = { ok: true, ownReady: false, ownReason: kind === 'timeout' ? 'timeout' : '需要先登录 DeepSeek 账号' }
    expect(await adapter.available()).toEqual(expected)
    expect(await adapter.available()).toEqual(expected)
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('探测复用 ENOENT 回退，版本失败保留原因', async () => {
    if (process.platform !== 'darwin') vi.stubEnv('DSH_BIN', '/configured/dsh')
    mockOutput('', { ok: false, error: 'timeout after 10ms' })
    vi.mocked(runProcess).mockResolvedValueOnce(missing)
    expect(await createDshHarness().available()).toEqual({ ok: false, reason: 'timeout after 10ms' })
    expect(vi.mocked(runProcess).mock.calls.map(call => call[0])).toEqual(
      process.platform === 'darwin' ? ['dsh', appBin] : ['/configured/dsh', 'dsh'],
    )
  })

  it('修改 DSH_BIN 后不复用其他二进制的缓存', async () => {
    mockOutput(fixture)
    const adapter = createDshHarness()
    await adapter.available()
    vi.stubEnv('DSH_BIN', '/changed/dsh')
    await adapter.available()
    expect(vi.mocked(runProcess).mock.calls.map(call => call[0])).toEqual(['dsh', 'dsh', '/changed/dsh', '/changed/dsh'])
  })
})
