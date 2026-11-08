import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, HarnessRequest } from '@taktflow/core'
import { createClaudeCodeHarness, createClaudeCodeParser } from './claude-code.js'
import { runProcess } from './process.js'
import type { ProcessResult } from './process.js'

vi.mock('./process.js', async importOriginal => ({
  ...await importOriginal<typeof import('./process.js')>(), runProcess: vi.fn(),
}))

// 按 Claude stream-json 格式构造的合成样例，非真实模型任务录制。
const fixture = `{"type":"system","subtype":"init","session_id":"claude-s","model":"opus"}
{"type":"assistant","message":{"content":[{"type":"text","text":"读取文件"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}},{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"false"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"exit 1"},{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"file body"}]}]}}
{"type":"result","is_error":false,"result":"完成","session_id":"claude-final","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":30},"total_cost_usd":0.12}`

// 2026-11-04本机手工探测录制，标识/文本脱敏且省略无关字段。
const recordedFixture = `{"type":"system","subtype":"init","session_id":"recorded-id"}
{"type":"assistant","session_id":"recorded-id","message":{"role":"assistant","type":"message","content":[{"type":"text","text":"[recorded text omitted]"}]},"error":"[recorded text omitted]"}
{"type":"result","subtype":"success","session_id":"recorded-id","result":"[recorded text omitted]","is_error":true,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"total_cost_usd":0}`
const req: HarnessRequest = { prompt: 'task $HOME `literal`', cwd: tmpdir() }
const success: ProcessResult = { ok: true, stdout: '', stderr: '', exitCode: 0 }

function mockOutput(output: string, proc: Partial<ProcessResult> = {}) {
  vi.mocked(runProcess).mockImplementation(async (_bin, _args, _req, options) => {
    output.split('\n').forEach(line => options?.onLine?.(line))
    return { ...success, stdout: output, ...proc }
  })
}

beforeEach(() => vi.mocked(runProcess).mockReset())

describe('Claude stream parser', () => {
  it('回放本机录制：result.subtype=success 不能覆盖 is_error=true', async () => {
    const parser = createClaudeCodeParser()
    recordedFixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toMatchObject({ ok: false, finalText: '[recorded text omitted]', sessionId: 'recorded-id',
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 } })
    expect(parser.result().error).toContain('"is_error":true')
    mockOutput(recordedFixture, { ok: false, exitCode: 1, error: '[recorded text omitted]', stderr: '[recorded text omitted]' })
    expect(await createClaudeCodeHarness().run(req, () => {})).toMatchObject({ ok: false, exitCode: 1 })
  })

  it.each([
    ['', ''],
    ['{"type":"system","subtype":"init","session_id":"s"}', ''],
    ['{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}', 'partial'],
  ])('进程 exit0 但缺少 result 时失败，并保留已有文本: %s', async (output, finalText) => {
    mockOutput(output)
    const result = await createClaudeCodeHarness().run(req, () => {})
    expect(result).toMatchObject({ ok: false, finalText, exitCode: 0 })
    expect(result.error).toMatch(/Incomplete.*missing terminal result/)
  })

  it('损坏协议 JSON 记录错误和 message，后续 result 不能洗白', () => {
    const events: HarnessEvent[] = []
    const parser = createClaudeCodeParser(event => events.push(event))
    parser.onLine('{"type":"error","message":"permission denied"')
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toMatchObject({ ok: false, finalText: '完成' })
    expect(parser.result().error).toContain('Malformed protocol JSON')
    expect(parser.result().error).toContain('permission denied')
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', role: 'system', text: expect.stringContaining('permission denied') }))
  })

  it('读取未完成快照不会导致后续正常 result 永久失败', () => {
    const parser = createClaudeCodeParser()
    expect(parser.result().ok).toBe(false)
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result().ok).toBe(true)
  })

  it('提取 session/result/usage/cost，并按 ID 关联乱序工具输出', () => {
    const events: HarnessEvent[] = []
    const parser = createClaudeCodeParser(event => events.push(event))
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toEqual({ ok: true, finalText: '完成', sessionId: 'claude-final',
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30, costUsd: 0.12 } })
    expect(events).toContainEqual({ type: 'started', sessionId: 'claude-s', model: 'opus' })
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '读取文件' })
    expect(events).toContainEqual({ type: 'tool_call', phase: 'end', callId: expect.any(String), durationMs: expect.any(Number), tool: 'Bash', input: '{"command":"false"}', output: 'exit 1', ok: false })
    expect(events).toContainEqual({ type: 'tool_call', phase: 'end', callId: expect.any(String), durationMs: expect.any(Number), tool: 'Read', input: '{"file_path":"a.ts"}', output: '[{"type":"text","text":"file body"}]', ok: true })
    expect(events).toContainEqual({ type: 'usage', usage: parser.result().usage })
  })

  it('result.is_error 保留嵌套错误，后续成功 result 不洗白', () => {
    const parser = createClaudeCodeParser()
    parser.onLine('{"type":"result","is_error":true,"errors":[{"code":429,"message":"rate limit"}]}')
    parser.onLine('{"type":"result","is_error":false,"result":"partial"}')
    expect(parser.result()).toMatchObject({ ok: false, finalText: 'partial' })
    expect(parser.result().error).toContain('429')
    expect(parser.result().error).toContain('rate limit')
  })

  it('无 result 时保留最后助手文本，不混入 user/未知/坏 JSON', () => {
    const events: HarnessEvent[] = []
    const parser = createClaudeCodeParser(event => events.push(event))
    for (const line of [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}',
      '{"type":"user","message":{"content":[{"type":"text","text":"user"},{"type":"tool_result","tool_use_id":"missing","content":"orphan"}]}}',
      '{bad json', '{"type":"future","text":"not final"}', 'null', '[]', '',
    ]) parser.onLine(line)
    expect(parser.result().finalText).toBe('ab')
    expect(events).toContainEqual({ type: 'message', role: 'system', text: '{bad json' })
    expect(events.some(event => event.type === 'message' && event.text.includes('orphan'))).toBe(true)
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(0)
  })

  it('不把不完整 usage 补零伪装成完整用量', () => {
    const parser = createClaudeCodeParser()
    parser.onLine('{"type":"result","usage":{"input_tokens":1},"total_cost_usd":0.2}')
    expect(parser.result().usage).toBeUndefined()
  })

  it('事件回调异常交给 process 层处理，不当坏 JSON 吞掉', () => {
    const parser = createClaudeCodeParser(() => { throw new Error('sink failed') })
    expect(() => parser.onLine('{"type":"system","subtype":"init"}')).toThrow('sink failed')
  })
})

describe('Claude adapter', () => {
  it('使用原生 system 参数并把 prompt 原样送到 stdin', async () => {
    mockOutput(fixture)
    const request = { ...req, model: 'opus', sessionId: 'old', systemAppend: 'system', env: { TEST: '1' }, timeoutMs: 1000 }
    const events: HarnessEvent[] = []
    const result = await createClaudeCodeHarness({ bin: '/custom/claude' }).run(request, event => events.push(event))
    expect(runProcess).toHaveBeenCalledWith('/custom/claude', ['-p', '--output-format', 'stream-json', '--verbose',
      '--model', 'opus', '--resume', 'old', '--append-system-prompt', 'system', '--permission-mode', 'bypassPermissions'],
    request, { stdin: req.prompt, onLine: expect.any(Function) })
    expect(result.ok).toBe(true)
    expect(events.some(event => event.type === 'usage')).toBe(true)
  })

  it('新会话不附加 resume/model/system 参数', async () => {
    mockOutput(fixture)
    await createClaudeCodeHarness().run(req, () => {})
    expect(vi.mocked(runProcess).mock.calls[0]?.slice(0, 2)).toEqual(['claude',
      ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']])
  })

  it('合并进程失败、解析错误、exitCode/transcript', async () => {
    mockOutput('{"type":"result","is_error":true,"result":"401 sign in"}', {
      ok: false, exitCode: 2, error: 'timeout\n503 overloaded', stderr: '503 overloaded', transcriptPath: '/tmp/transcript',
    })
    const result = await createClaudeCodeHarness().run(req, () => {})
    expect(result).toMatchObject({ ok: false, exitCode: 2, transcriptPath: '/tmp/transcript' })
    expect(result.error).toContain('401')
    expect(result.error).toContain('timeout')
    expect(result.error).toContain('503 overloaded')
  })

  it.each([
    ['```json\n{"a":1}\n```\n```json\n{"a":2}\n```', { a: 2 }],
    ['```json\n{"a":1}\n```\n```json\nbroken\n```', undefined],
    ['plain answer', undefined],
  ])('schema 存在才提取最后块，不做校验: %s', async (answer, structured) => {
    mockOutput(JSON.stringify({ type: 'result', result: answer, is_error: false }))
    const adapter = createClaudeCodeHarness()
    expect(await adapter.run({ ...req, resultSchema: {} }, () => {})).toMatchObject({ ok: true, structured })
    expect(await adapter.run(req, () => {})).not.toHaveProperty('structured')
  })

  it.each([true, false])('available 只调用 --version: %s', async ok => {
    vi.mocked(runProcess).mockResolvedValue({ ...success, ok, error: ok ? undefined : 'ENOENT' })
    expect(await createClaudeCodeHarness().available()).toEqual(ok ? { ok: true } : { ok: false, reason: 'ENOENT' })
    expect(runProcess).toHaveBeenCalledWith('claude', ['--version'], expect.objectContaining({ timeoutMs: 5000 }))
  })
})
