import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessEvent } from '@taktflow/core'
import { createHarnesses } from '../index.js'
import { parseHarnessStream, runHarnessConformance } from '../testing/conformance.js'
import { jsonl, streamFixtures } from '../testing/fixtures.js'
import { createPiHarness, createPiParser } from './pi.js'

// 按官方 docs/json.md / message-types.md / cli.md 构造的样例，不是真实模型调用实录。
const session = { type: 'session', version: 3, id: 'pi-session', timestamp: '2026-11-05T00:00:00.000Z', cwd: '/tmp' }
const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.01, cacheWrite: 0.01, total: 0.05 } }
const assistant = (text: string, stopReason = 'stop') => ({ role: 'assistant',
  content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'anthropic', model: 'test-model',
  usage, stopReason, timestamp: 1793836800000 })
const start = { type: 'message_start', message: { ...assistant(''), content: [], stopReason: 'pending' } }
const settled = { type: 'agent_settled', aborted: false }
const update = (event: unknown) => ({ type: 'message_update', usage, assistantMessageEvent: event })
const finish = (text: string) => [
  { type: 'message_end', message: assistant(text) },
  { type: 'turn_end', message: assistant(text), toolResults: [] },
  { type: 'agent_end', messages: [assistant(text)], willRetry: false }, settled,
]
const fixtures = streamFixtures(text => jsonl(
  session, { type: 'agent_start' }, { type: 'turn_start' },
  { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'a.ts' } },
  { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read',
    result: { content: [{ type: 'text', text: 'source' }] }, isError: false },
  start, update({ type: 'text_start', contentIndex: 0 }),
  update({ type: 'text_delta', contentIndex: 0, delta: text }),
  update({ type: 'text_end', contentIndex: 0, content: text }), ...finish(text),
), errorMessage => jsonl(session, start,
  { type: 'message_end', message: { ...assistant('', 'error'), errorMessage } },
  { type: 'agent_end', messages: [], willRetry: false }, settled,
), {
  started: { type: 'started', sessionId: 'pi-session' },
  message: { type: 'message', role: 'assistant', text: '最终回答' },
  toolCall: { type: 'tool_call', phase: 'end', callId: 'call-1', tool: 'read', input: '{"path":"a.ts"}',
    output: '{"content":[{"type":"text","text":"source"}]}', ok: true },
  usage: { inputTokens: 140, outputTokens: 20, cachedTokens: 30, costUsd: 0.05 }, finalText: '最终回答',
}, '按 Pi 官方 JSON Event Stream、Message Types 文档合成，非 CLI 实录')

runHarnessConformance('Pi', {
  parse: parseHarnessStream(createPiParser), fixtures,
  runtime: { create: bin => createPiHarness({ bin }), replay: fixtures },
})

function recording() {
  const events: HarnessEvent[] = []
  const parser = createPiParser(event => events.push(event))
  const send = (...data: unknown[]) => data.forEach(value => parser.onLine(JSON.stringify(value)))
  send(session)
  return { parser, events, send }
}

async function inTemp(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'takt-pi-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('Pi JSONL 协议', () => {
  it('按 contentIndex 重建，完成块与 message_end 替换增量，thinking 不混入最终文本', () => {
    const { parser, events, send } = recording()
    send(start,
      update({ type: 'text_delta', contentIndex: 2, delta: '世界' }),
      update({ type: 'thinking_start', contentIndex: 1 }),
      update({ type: 'thinking_delta', contentIndex: 1, delta: '内部思考' }),
      update({ type: 'thinking_end', contentIndex: 1, content: '思考完成' }),
      update({ type: 'text_start', contentIndex: 0 }),
      update({ type: 'text_delta', contentIndex: 0, delta: '你' }),
      update({ type: 'text_delta', contentIndex: 0, delta: '好' }),
    )
    expect(parser.result()).toMatchObject({ ok: false, finalText: '你好世界' })
    send(update({ type: 'text_end', contentIndex: 0, content: '您好' }))
    expect(parser.result().finalText).toBe('您好世界')
    send(...finish('权威最终文本'))
    expect(parser.result()).toMatchObject({ ok: true, finalText: '权威最终文本' })
    expect(events.filter(event => event.type === 'message')).toEqual([
      { type: 'message', role: 'assistant', text: '权威最终文本' },
    ])
    expect(events.filter(event => event.type === 'usage')).toHaveLength(1)
  })

  it('工具增量不提前执行，完成消息及执行开始只发一次调用，按 ID 配对并发结果', () => {
    const { events, send } = recording()
    const calls = ['one', 'two'].map(id => ({ type: 'toolCall', id, name: 'read', arguments: { path: id } }))
    send(start,
      update({ type: 'toolcall_start', contentIndex: 0, id: 'one', toolName: 'read' }),
      update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' }),
      update({ type: 'toolcall_delta', contentIndex: 0, delta: '"one"}' }),
      update({ type: 'toolcall_end', contentIndex: 0, toolCall: calls[0] }),
    )
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(0)
    send({ type: 'message_end', message: { ...assistant('', 'toolUse'), content: calls } })
    for (const call of calls) send({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments })
    send({ type: 'tool_execution_end', toolCallId: 'two', result: 'second', isError: true },
      { type: 'tool_execution_end', toolCallId: 'one', result: 'first', isError: false })
    expect(events.filter(event => event.type === 'tool_call')).toEqual([
      { type: 'tool_call', phase: 'start', callId: 'one', tool: 'read', input: '{"path":"one"}' },
      { type: 'tool_call', phase: 'start', callId: 'two', tool: 'read', input: '{"path":"two"}' },
      { type: 'tool_call', phase: 'end', callId: 'two', durationMs: expect.any(Number), tool: 'read', input: '{"path":"two"}', output: 'second', ok: false },
      { type: 'tool_call', phase: 'end', callId: 'one', durationMs: expect.any(Number), tool: 'read', input: '{"path":"one"}', output: 'first', ok: true },
    ])
  })

  it('跨轮累加用量，忽略重复快照与累计 update；最终文本只保留最后一轮', () => {
    const { parser, events, send } = recording()
    send(start, update({ type: 'text_delta', contentIndex: 0, delta: '中间' }),
      { type: 'message_end', message: assistant('中间', 'toolUse') },
      { type: 'turn_end', message: assistant('中间', 'toolUse'), toolResults: [] },
      { type: 'turn_start' }, start, ...finish('最终'))
    expect(parser.result()).toMatchObject({ ok: true, finalText: '最终',
      usage: { inputTokens: 280, outputTokens: 40, cachedTokens: 60, costUsd: 0.1 } })
    expect(events.filter(event => event.type === 'usage')).toHaveLength(2)
  })

  it('agent_end 不是完成边界，重试成功后等待 agent_settled', () => {
    const { parser, send } = recording()
    send(start, { type: 'message_end', message: { ...assistant('', 'error'), errorMessage: 'temporary failure' } },
      { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'temporary failure' })
    expect(parser.result().ok).toBe(false)
    send({ type: 'agent_start' }, { type: 'turn_start' }, start, ...finish('恢复').slice(0, -1),
      { type: 'auto_retry_end', success: true, attempt: 1 })
    expect(parser.result().ok).toBe(false)
    send(settled)
    expect(parser.result()).toMatchObject({ ok: true, finalText: '恢复' })
  })

  it.each(['length', 'toolUse', 'error', 'aborted', 'pending', 'deferred', undefined])('stopReason=%s 不误报成功', stopReason => {
    const { parser, send } = recording()
    send(start, { type: 'message_end', message: { ...assistant('部分输出'), stopReason } }, settled)
    expect(parser.result().ok).toBe(false)
  })

  it('流截断、取消、重试耗尽、坏 JSON 和缺少 session 均失败', () => {
    for (const input of [
      jsonl(session, start, update({ type: 'text_delta', contentIndex: 0, delta: '部分输出' }), settled),
      jsonl(session, start, ...finish('完成').slice(0, -1), { ...settled, aborted: true }),
      jsonl(session, { type: 'auto_retry_end', success: false, finalError: 'HTTP 503 overloaded' }),
      jsonl(session, start, ...finish('完成')) + '\n{"type":',
      jsonl(start, ...finish('完成')), '[]', 'null', 'diagnostic on stdout',
    ]) {
      const parser = createPiParser()
      input.split('\n').forEach(parser.onLine)
      expect(parser.result().ok).toBe(false)
    }
  })

  it('压缩映射前后 token 与触发来源，失败或缺少估算时不捏造记录', () => {
    const { events, send } = recording()
    for (const reason of ['manual', 'threshold', 'overflow']) send({ type: 'compaction_end', reason,
      result: { summary: '摘要', firstKeptEntryId: 'entry', tokensBefore: 150000, estimatedTokensAfter: 32000 }, aborted: false })
    send({ type: 'compaction_end', aborted: true },
      { type: 'compaction_end', aborted: false, errorMessage: 'failed' },
      { type: 'compaction_end', result: { summary: '摘要', tokensBefore: 100 } })
    const compactions = events.filter(event => event.type === 'compacted')
    expect(compactions).toHaveLength(3)
    expect(compactions.map(event => event.record.trigger)).toEqual(['manual', 'auto', 'auto'])
    expect(compactions[0]).toMatchObject({ record: { beforeTokens: 150000, afterTokens: 32000, summary: '摘要', dropped: [] } })
  })

  it('未知事件保留为系统消息', () => {
    const { events, send } = recording()
    send({ type: 'future_event', detail: 'value' })
    expect(events).toContainEqual({ type: 'message', role: 'system', text: '{"type":"future_event","detail":"value"}' })
  })
})

describe('Pi CLI 接入', () => {
  it('注册能力与可用性探测，模型/provider/续聊/思考参数准确，prompt 经 stdin 原样传入', () => inTemp(async dir => {
    const bin = join(dir, 'pi-fixture')
    await writeFile(bin, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(join(dir, 'invocation.json'))}, JSON.stringify({args: process.argv.slice(2), input}));
  process.stdout.write(${JSON.stringify(fixtures.success.input)});
});
`, { mode: 0o700 })
    const harness = createHarnesses({ pi: { bin, provider: 'anthropic' } }).pi!
    expect(harness.capabilities).toMatchObject({ resume: true, compactionEvents: true, usage: true, cost: true,
      structuredOutput: false, customProvider: false, sandbox: false, mcp: true })
    expect(await harness.available()).toEqual({ ok: true })
    const prompt = '-literal @missing.txt\nUnicode \u2028 \u2029'
    const result = await harness.run({ cwd: dir, prompt, model: 'test-model', effort: 'max',
      sessionId: 'pi-session', systemAppend: '角色说明' }, () => {})
    expect(result.ok).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'invocation.json'), 'utf8'))).toEqual({
      args: ['--mode', 'json', '--model', 'test-model', '--provider', 'anthropic', '--session', 'pi-session',
        '--thinking', 'max', '--append-system-prompt', '角色说明'], input: prompt,
    })
  }))

  it('原始 stdout 仅按 LF 分割，跨 UTF-8 字节分块、CRLF 与 Unicode 分隔符不破坏消息', () => inTemp(async dir => {
    const bin = join(dir, 'pi-fixture')
    const text = '中文\u2028保留\u2029段落\r换行'
    const output = jsonl(session, start, ...finish(text)).replaceAll('\n', '\r\n')
    await writeFile(bin, `#!${process.execPath}
const output = Buffer.from(${JSON.stringify(output)});
let index = 0;
function next() {
  if (index === output.length) return;
  process.stdout.write(output.subarray(index, ++index));
  setImmediate(next);
}
next();
`, { mode: 0o700 })
    const events: HarnessEvent[] = []
    const transcript = join(dir, 'transcript.jsonl')
    const result = await createPiHarness({ bin }).run({ cwd: dir, prompt: 'test', env: { TAKT_TRANSCRIPT: transcript } }, event => events.push(event))
    expect(result).toMatchObject({ ok: true, finalText: text, transcriptPath: transcript })
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text })
    expect(await readFile(transcript, 'utf8')).toContain(text.replaceAll('\r', '\\r'))
  }))

  it('缺少可执行文件报告不可用；不静默忽略 provider 连接配置', async () => {
    const harness = createPiHarness({ bin: '/nonexistent-takt-pi' })
    expect(await harness.available()).toMatchObject({ ok: false, reason: expect.stringContaining('ENOENT') })
    expect(await harness.run({ cwd: tmpdir(), prompt: '', provider: { id: 'custom', protocol: 'openai-chat' } }, () => {}))
      .toMatchObject({ ok: false, error: expect.stringContaining('customProvider') })
    expect(await createPiHarness({ bin: '/nonexistent-takt-pi', provider: 'anthropic' }).run({ cwd: tmpdir(), prompt: '' }, () => {}))
      .toMatchObject({ ok: false, error: expect.stringContaining('--provider requires --model') })
  })

  it('transcript、事件及最终结果均脱敏', () => inTemp(async dir => {
    const bin = join(dir, 'pi-fixture')
    const secret = 'synthetic-pi-secret-for-test'
    await writeFile(bin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(jsonl(session, start, ...finish(secret)))});\n`, { mode: 0o700 })
    const events: HarnessEvent[] = []
    const transcript = join(dir, 'transcript.jsonl')
    const result = await createPiHarness({ bin }).run({ cwd: dir, prompt: '',
      env: { PI_API_KEY: secret, TAKT_TRANSCRIPT: transcript } }, event => events.push(event))
    expect(result.ok).toBe(true)
    expect(JSON.stringify({ result, events })).not.toContain(secret)
    expect(await readFile(transcript, 'utf8')).not.toContain(secret)
  }))

  it('transcript 无法创建时不启动 CLI，避免丢失留痕', () => inTemp(async dir => {
    const bin = join(dir, 'pi-fixture')
    const marker = join(dir, 'started')
    await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`, { mode: 0o700 })
    const result = await createPiHarness({ bin }).run({ cwd: dir, prompt: '', env: { TAKT_TRANSCRIPT: dir } }, () => {})
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('transcript failed') })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  }))

  it('空流退出 0 与完整事件流退出非零都不能误报成功', () => inTemp(async dir => {
    const bin = join(dir, 'pi-fixture')
    await writeFile(bin, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 })
    expect(await createPiHarness({ bin }).run({ cwd: dir, prompt: '' }, () => {}))
      .toMatchObject({ ok: false, error: expect.stringContaining('Incomplete Pi stream') })
    await writeFile(bin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(fixtures.success.input)});\nprocess.exitCode = 7;\n`)
    expect(await createPiHarness({ bin }).run({ cwd: dir, prompt: '' }, () => {}))
      .toMatchObject({ ok: false, finalText: '最终回答', exitCode: 7, error: expect.stringContaining('code 7') })
  }))
})
