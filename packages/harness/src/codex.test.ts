import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, HarnessRequest } from '@taktflow/core'
import { createCodexHarness, createCodexParser } from './codex.js'
import { runProcess } from './process.js'
import type { ProcessResult } from './process.js'

vi.mock('./process.js', async importOriginal => ({
  ...await importOriginal<typeof import('./process.js')>(), runProcess: vi.fn(),
}))

// 按 Codex JSONL 格式构造的合成样例，非真实模型任务录制。
const fixture = `{"type":"thread.started","thread_id":"thread-1"}
{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"计划"}}
{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"cat a.ts","aggregated_output":"source","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"i3","type":"file_change","changes":[{"path":"a.ts","kind":"update"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"i4","type":"agent_message","text":"最终回答"}}
{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":30}}`

// 2026-11-04本机手工探测录制，标识/文本脱敏且省略无关字段。
const recordedFixture = `{"type":"thread.started","thread_id":"recorded-id"}
{"type":"item.completed","item":{"id":"recorded-id","type":"error","message":"[recorded text omitted]"}}
{"type":"item.completed","item":{"id":"recorded-id","type":"error","message":"[recorded text omitted]"}}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"recorded-id","type":"agent_message","text":"TAKTFLOW_HARNESS_PROBE_OK"}}
{"type":"turn.completed","usage":{"input_tokens":13799,"cached_input_tokens":13440,"cache_write_input_tokens":0,"output_tokens":14,"reasoning_output_tokens":0}}`
const req: HarnessRequest = { prompt: 'task $HOME `literal`', cwd: tmpdir() }
const success: ProcessResult = { ok: true, stdout: '', stderr: '', exitCode: 0 }

function mockOutput(output: string, proc: Partial<ProcessResult> = {}) {
  vi.mocked(runProcess).mockImplementation(async (_bin, _args, _req, options) => {
    output.split('\n').forEach(line => options?.onLine?.(line))
    return { ...success, stdout: output, ...proc }
  })
}

beforeEach(() => vi.mocked(runProcess).mockReset())

describe('Codex parser', () => {
  it('回放本机录制：两条 item.error 通知后整轮成功，通知仍保留为 system message', async () => {
    mockOutput(recordedFixture, { stderr: '[recorded text omitted]', exitCode: 0 })
    const events: HarnessEvent[] = []
    const result = await createCodexHarness().run(req, event => events.push(event))
    expect(result).toMatchObject({ ok: true, exitCode: 0, sessionId: 'recorded-id', finalText: 'TAKTFLOW_HARNESS_PROBE_OK',
      usage: { inputTokens: 13799, cachedTokens: 13440, outputTokens: 14 } })
    expect(result.error).toBeUndefined()
    const notification = { type: 'message', role: 'system', text: '{"id":"recorded-id","type":"error","message":"[recorded text omitted]"}' }
    expect(events.filter(event => event.type === 'message' && event.role === 'system' && event.text.includes('"type":"error"')))
      .toEqual([notification, notification])
  })

  // 以下继续使用合成序列覆盖失败边界。
  it.each([false, true])('item.error 不替代终止事件或进程退出状态：有 terminal=%s', async terminal => {
    const output = '{"type":"item.completed","item":{"type":"error","message":"401 sign in"}}'
      + (terminal ? '\n{"type":"turn.completed"}' : '')
    mockOutput(output, terminal ? { ok: false, exitCode: 1, error: 'Process exited with code 1' } : {})
    const events: HarnessEvent[] = []
    const result = await createCodexHarness().run(req, event => events.push(event))
    expect(result.ok).toBe(false)
    expect(result.error).toContain(terminal ? 'Process exited with code 1' : 'missing terminal turn.completed')
    expect(events).toContainEqual({ type: 'message', role: 'system', text: '{"type":"error","message":"401 sign in"}' })
  })

  it.each([
    ['', ''],
    ['{"type":"thread.started","thread_id":"s"}', ''],
    ['{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}', 'partial'],
  ])('进程 exit0 但缺少 turn.completed 时失败，并保留已有文本: %s', async (output, finalText) => {
    mockOutput(output)
    const result = await createCodexHarness().run(req, () => {})
    expect(result).toMatchObject({ ok: false, finalText, exitCode: 0 })
    expect(result.error).toMatch(/Incomplete.*missing terminal turn.completed/)
  })

  it('损坏协议 JSON 记录错误和 message，后续 turn.completed 不能洗白', () => {
    const events: HarnessEvent[] = []
    const parser = createCodexParser(event => events.push(event))
    parser.onLine('{"type":"error","message":"permission denied"')
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toMatchObject({ ok: false, finalText: '最终回答' })
    expect(parser.result().error).toContain('Malformed protocol JSON')
    expect(parser.result().error).toContain('permission denied')
    expect(events).toContainEqual(expect.objectContaining({ type: 'message', role: 'system', text: expect.stringContaining('permission denied') }))
  })

  it('读取未完成快照不会导致后续正常 turn.completed 永久失败', () => {
    const parser = createCodexParser()
    expect(parser.result().ok).toBe(false)
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result().ok).toBe(true)
  })

  it('最后 agent_message 是最终回答，映射 thread/command/file/usage', () => {
    const events: HarnessEvent[] = []
    const parser = createCodexParser(event => events.push(event))
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toEqual({ ok: true, finalText: '最终回答', sessionId: 'thread-1',
      usage: { inputTokens: 200, outputTokens: 30, cachedTokens: 50 } })
    expect(events).toContainEqual({ type: 'started', sessionId: 'thread-1', model: undefined })
    expect(events).toContainEqual({ type: 'tool_call', tool: 'command_execution', input: 'cat a.ts', output: 'source', ok: true })
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', tool: 'file_change', input: '[{"path":"a.ts","kind":"update"}]', ok: true }))
    expect(events).toContainEqual({ type: 'usage', usage: parser.result().usage })
  })

  it.each([
    { type: 'error', message: '503 overloaded' },
    { type: 'turn.failed', error: { message: 'rate limit', code: 429 } },
  ])('错误不会被后续成功事件覆盖: %j', error => {
    const parser = createCodexParser()
    parser.onLine(JSON.stringify(error))
    fixture.split('\n').forEach(parser.onLine)
    expect(parser.result()).toMatchObject({ ok: false, finalText: '最终回答' })
    expect(parser.result().error).toMatch(/503|429/)
  })

  it('保留工具失败和 MCP/web search，未知/思考/坏 JSON 不污染 final', () => {
    const events: HarnessEvent[] = []
    const parser = createCodexParser(event => events.push(event))
    fixture.split('\n').forEach(parser.onLine)
    for (const item of [
      { type: 'command_execution', command: 'false', aggregated_output: 'bad', exit_code: 1, status: 'failed' },
      { type: 'mcp_tool_call', server: 'server', tool: 'read', arguments: { path: 'a' }, result: { text: 'body' }, status: 'completed' },
      { type: 'mcp_tool_call', server: 'server', tool: 'write', arguments: {}, error: { message: 'denied' }, status: 'failed' },
      { type: 'web_search', query: 'docs' }, { type: 'reasoning', text: 'thoughts' }, { type: 'new_item', text: 'unknown' },
    ]) parser.onLine(JSON.stringify({ type: 'item.completed', item }))
    for (const line of ['{broken', 'null', '[]', '42', '', '{"type":"new_event","text":"unknown"}']) parser.onLine(line)
    expect(parser.result()).toMatchObject({ ok: true, finalText: '最终回答' })
    expect(events).toContainEqual({ type: 'tool_call', tool: 'command_execution', input: 'false', output: 'bad', ok: false })
    expect(events).toContainEqual({ type: 'tool_call', tool: 'server.read', input: '{"path":"a"}', output: '{"text":"body"}', ok: true })
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', tool: 'server.write', ok: false }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', tool: 'web_search', input: 'docs' }))
    expect(events).toContainEqual({ type: 'message', role: 'system', text: '{broken' })
  })
})

describe('Codex adapter', () => {
  it.each([undefined, 'thread-old'])('公共 exec 参数在 resume 前: %s', async sessionId => {
    mockOutput(fixture)
    const request = { ...req, model: 'gpt', effort: 'high' as const, sessionId, systemAppend: 'role instructions' }
    const result = await createCodexHarness({ bin: '/custom/codex' }).run(request, () => {})
    expect(runProcess).toHaveBeenCalledWith('/custom/codex', [
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', req.cwd, '-c', 'features.memories=false',
      '-m', 'gpt', '-c', 'model_reasoning_effort="high"', ...(sessionId ? ['resume', sessionId] : []), '-',
    ], request, { stdin: `role instructions\n\n${req.prompt}`, onLine: expect.any(Function) })
    expect(result.sessionId).toBe('thread-1')
  })

  it('默认命令只使用必需参数（关掉个人记忆），原样透传 stdin、取消及环境', async () => {
    mockOutput(fixture)
    const request = { ...req, signal: new AbortController().signal, env: { TEST: '1' } }
    await createCodexHarness().run(request, () => {})
    expect(runProcess).toHaveBeenCalledWith('codex', ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', req.cwd, '-c', 'features.memories=false', '-'],
      request, { stdin: req.prompt, onLine: expect.any(Function) })
  })

  it('合并进程失败与解析错误，不丢 transcript/exitCode', async () => {
    mockOutput('{"type":"turn.failed","error":{"message":"429 rate limit"}}', {
      ok: false, error: 'timeout\n503 overloaded', stderr: '503 overloaded', exitCode: 7, transcriptPath: '/tmp/codex.jsonl',
    })
    const result = await createCodexHarness().run(req, () => {})
    expect(result).toMatchObject({ ok: false, exitCode: 7, transcriptPath: '/tmp/codex.jsonl' })
    expect(result.error).toContain('429')
    expect(result.error).toContain('timeout')
    expect(result.error).toContain('503 overloaded')
  })

  it.each([
    ['```json\n{"n":1}\n```\n```json\n{"n":2}\n```', { n: 2 }],
    ['```json\n{"n":1}\n```\n```json\nbad\n```', undefined],
    ['no json', undefined],
  ])('只在 schema 存在时提取最后块: %s', async (answer, structured) => {
    mockOutput(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } })}\n{"type":"turn.completed"}`)
    const adapter = createCodexHarness()
    expect(await adapter.run({ ...req, resultSchema: {} }, () => {})).toMatchObject({ ok: true, structured })
    expect(await adapter.run(req, () => {})).not.toHaveProperty('structured')
  })

  it.each([true, false])('available 只检查 version: %s', async ok => {
    vi.mocked(runProcess).mockResolvedValue({ ...success, ok, error: ok ? undefined : 'EACCES' })
    expect(await createCodexHarness({ bin: '/custom/codex' }).available()).toEqual(ok ? { ok: true } : { ok: false, reason: 'EACCES' })
    expect(runProcess).toHaveBeenCalledWith('/custom/codex', ['--version'], expect.objectContaining({ timeoutMs: 5000 }))
  })
})
