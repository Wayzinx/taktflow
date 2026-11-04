import { mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CliHarnessConfig, HarnessEvent, HarnessRequest } from '@taktflow/core'
import { createCliHarness, createCliParser, inferCliCapabilities } from './cli-generic.js'

const node = process.execPath
const cleanup: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function request(overrides: Partial<HarnessRequest> = {}): Promise<HarnessRequest> {
  return { prompt: 'ask', cwd: await tempDir('takt-cli-cwd-'), ...overrides }
}

function collectEvents(): { events: HarnessEvent[]; onEvent: (event: HarnessEvent) => void } {
  const events: HarnessEvent[] = []
  return { events, onEvent: event => events.push(event) }
}

describe('prompt 传入方式', () => {
  it('stdin：prompt 原样写入标准输入，stdout 原样作为 finalText', async () => {
    const config: CliHarnessConfig = {
      id: 'stdin-cli', kind: 'cli',
      command: [node, '-e', 'process.stdin.pipe(process.stdout)'],
      output: { format: 'text' },
    }
    const result = await createCliHarness(config).run(await request({ prompt: '第一行\n第二行' }), () => {})
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('第一行\n第二行')
  })

  it('arg：未知占位符与 prompt 内容里的占位符保持字面，不经过 shell', async () => {
    const script = 'process.stdout.write(process.argv.slice(1).join("\\n"))'
    const config: CliHarnessConfig = {
      id: 'arg-cli', kind: 'cli',
      command: [node, '-e', script, '--', '--title', '{{unknown}}', '{{constructor}}', '--prompt', '{{prompt}}', '--literal', 'a; b $(x)'],
      output: { format: 'text' },
    }
    const prompt = '原文 {{cwd}} {{model}} {{sessionId}} {{promptFile}} {{prompt}} $& $` $\' " \\ \n'
    const result = await createCliHarness(config).run(await request({ prompt, model: 'real-model', sessionId: 'real-session' }), () => {})
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe(`--title\n{{unknown}}\n{{constructor}}\n--prompt\n${prompt}\n--literal\na; b $(x)`)
  })

  it.each(['stdin', 'arg', 'file'] as const)('显式 %s 模式保留 systemAppend 和 prompt 字面内容', async promptVia => {
    const script = promptVia === 'stdin' ? 'process.stdin.pipe(process.stdout)'
      : promptVia === 'arg' ? 'process.stdout.write(process.argv[1])'
        : 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))'
    const config: CliHarnessConfig = {
      id: 'explicit', kind: 'cli', promptVia,
      command: [node, '-e', script, ...(promptVia === 'stdin' ? [] : [promptVia === 'arg' ? '{{prompt}}' : '{{promptFile}}'])],
      output: { format: 'text' },
    }
    const result = await createCliHarness(config).run(await request({ prompt: '{{cwd}} {{model}}', systemAppend: 'system {{prompt}}' }), () => {})
    expect(result).toMatchObject({ ok: true, finalText: 'system {{prompt}}\n\n{{cwd}} {{model}}' })
  })

  it.each(['arg', 'file'] as const)('显式 %s 缺少占位符时拒绝静默丢失 prompt', promptVia => {
    expect(() => createCliHarness({ id: 'bad', kind: 'cli', command: [node], promptVia, output: { format: 'text' } })).toThrow(/缺少/)
  })

  it('file：写入 0600 的 mkdtemp 临时文件、拼入 systemAppend，运行结束后清理', async () => {
    const script = 'const fs=require("fs");const p=process.argv[1];const s=fs.statSync(p);'
      + 'process.stdout.write(JSON.stringify({path:p,content:fs.readFileSync(p,"utf8"),mode:(s.mode&0o777).toString(8)}))'
    const config: CliHarnessConfig = {
      id: 'file-cli', kind: 'cli',
      command: [node, '-e', script, '{{promptFile}}'],
      output: { format: 'text' },
    }
    const result = await createCliHarness(config).run(await request({ prompt: '文件里的 prompt', systemAppend: '角色说明' }), () => {})
    expect(result.ok).toBe(true)
    const payload = JSON.parse(result.finalText) as { path: string; content: string; mode: string }
    expect(payload.content).toBe('角色说明\n\n文件里的 prompt')
    expect(payload.mode).toBe('600')
    expect(payload.path.startsWith(tmpdir())).toBe(true)
    await expect(stat(payload.path)).rejects.toThrow()
    await expect(readdir(dirname(payload.path))).rejects.toThrow()
  })
})

describe('命令与运行参数', () => {
  it('替换 {{cwd}} / {{model}} / {{sessionId}}，并合并 model.flag / model.env / resume.args / config.env 与 req.env', async () => {
    const script = 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),A:process.env.A,B:process.env.B,CLI_MODEL:process.env.CLI_MODEL}))'
    const config: CliHarnessConfig = {
      id: 'flags-cli', kind: 'cli',
      command: [node, '-e', script, 'cwd={{cwd}}', 'model={{model}}', 'session={{sessionId}}'],
      model: { flag: '--model', env: 'CLI_MODEL' },
      resume: { args: ['--resume', '{{sessionId}}'] },
      env: { A: 'config', B: 'config' },
      output: { format: 'text' },
    }
    const cwd = await tempDir('takt-cli-flags-')
    const harness = createCliHarness(config)
    const first = await harness.run(await request({ cwd, model: 'm-1', sessionId: 's-1', env: { B: 'request' } }), () => {})
    expect(first.ok).toBe(true)
    const payload = JSON.parse(first.finalText) as { argv: string[]; A: string; B: string; CLI_MODEL: string }
    expect(payload.argv).toEqual([`cwd=${cwd}`, 'model=m-1', 'session=s-1', '--model', 'm-1', '--resume', 's-1'])
    expect(payload.A).toBe('config')
    expect(payload.B).toBe('request')
    expect(payload.CLI_MODEL).toBe('m-1')

    const secondCwd = await tempDir('takt-cli-flags2-')
    const second = await harness.run(await request({ cwd: secondCwd }), () => {})
    const secondPayload = JSON.parse(second.finalText) as { argv: string[] }
    expect(secondPayload.argv).toEqual([`cwd=${secondCwd}`, 'model=', 'session='])
    const overridden = await harness.run(await request({ model: 'm-1', env: { CLI_MODEL: 'request-model' } }), () => {})
    expect(JSON.parse(overridden.finalText).CLI_MODEL).toBe('request-model')
  })

  it('capabilities 按实际映射推断，显式声明只能关闭能力', () => {
    const minimal: CliHarnessConfig = { id: 'min', kind: 'cli', command: ['min'], output: { format: 'text' } }
    expect(inferCliCapabilities(minimal)).toEqual({
      resume: false, structuredOutput: false, toolEvents: false, usage: false,
      cost: false, compactionEvents: false, customProvider: false, sandbox: false, mcp: false,
    })
    const rich: CliHarnessConfig = {
      id: 'rich', kind: 'cli', command: ['rich'],
      resume: { args: ['--resume', '{{sessionId}}'] },
      capabilities: { sandbox: true, toolEvents: false, customProvider: true, structuredOutput: true, cost: true, compactionEvents: true, mcp: true },
      output: { format: 'jsonl', events: { type: 'type', text: 'text', tool: 'tool', inputTokens: 'usage.input', outputTokens: 'usage.output' } },
    }
    expect(createCliHarness(rich).capabilities).toMatchObject({
      resume: true, toolEvents: false, usage: true, structuredOutput: false, customProvider: false, sandbox: false,
      cost: false, compactionEvents: false, mcp: false,
    })
    expect(inferCliCapabilities({ ...rich, output: { ...rich.output, format: 'text' } })).toMatchObject({ toolEvents: false, usage: false })
    expect(inferCliCapabilities({ ...minimal, capabilities: { resume: true, toolEvents: true, usage: true } })).toMatchObject({ resume: false, toolEvents: false, usage: false })
    expect(inferCliCapabilities({ ...minimal, command: ['cli', '{{sessionId}}'] }).resume).toBe(true)
    expect(inferCliCapabilities({ ...rich, resume: { args: ['--resume'] } }).resume).toBe(false)
    expect(inferCliCapabilities({ ...rich, output: { format: 'jsonl', events: { inputTokens: 'input' } } }).usage).toBe(false)
    expect(inferCliCapabilities({ ...rich, output: { format: 'jsonl', events: { outputTokens: 'output' } } }).usage).toBe(false)
  })
})

describe('jsonl 输出映射', () => {
  const mapper = {
    type: 'kind', text: 'data.text', tool: 'name', toolInput: 'args',
    sessionId: 'session_id', inputTokens: 'tokens.input', outputTokens: 'tokens.output',
    final: { field: 'kind', equals: 'done' },
  }
  const lines = [
    '{"kind":"meta","session_id":"s-9"}',
    '{"kind":"message","data":{"text":"draft"}}',
    '{"kind":"tool","name":"read_file","args":{"path":"a.ts"}}',
    '{"kind":"usage","tokens":{"input":10,"output":4}}',
    '{"kind":"message","data":{"text":"final answer"}}',
    '{"kind":"done","data":{"text":"final answer"}}',
  ]

  it('解析器区分 started / message / tool_call / usage / final，finalText 不混入工具内容', () => {
    const config: CliHarnessConfig = { id: 'jsonl-cli', kind: 'cli', command: ['jsonl'], output: { format: 'jsonl', events: mapper } }
    const { events, onEvent } = collectEvents()
    const parser = createCliParser(config, onEvent)
    for (const line of lines) parser.onLine(line)
    const result = parser.result()
    expect(events).toEqual([
      { type: 'started', sessionId: 's-9', model: undefined },
      { type: 'message', role: 'assistant', text: 'draft' },
      { type: 'tool_call', tool: 'read_file', input: '{"path":"a.ts"}' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'message', role: 'assistant', text: 'final answer' },
      { type: 'message', role: 'assistant', text: 'final answer' },
    ])
    expect(result).toMatchObject({ ok: true, finalText: 'final answer', sessionId: 's-9', usage: { inputTokens: 10, outputTokens: 4 } })
    expect(result.finalText).not.toContain('read_file')
    expect(result.finalText).not.toContain('a.ts')
  })

  it('通过真实子进程跑 jsonl 输出', async () => {
    const script = `for (const line of ${JSON.stringify(lines)}) console.log(line)`
    const config: CliHarnessConfig = { id: 'jsonl-run', kind: 'cli', command: [node, '-e', script], output: { format: 'jsonl', events: mapper } }
    const { events, onEvent } = collectEvents()
    const result = await createCliHarness(config).run(await request({ model: 'cli-1' }), onEvent)
    expect(result).toMatchObject({ ok: true, finalText: 'final answer', sessionId: 's-9' })
    expect(events.some(event => event.type === 'started' && event.model === 'cli-1')).toBe(true)
    expect(events.some(event => event.type === 'tool_call')).toBe(true)
  })

  it('tool_error 后模型恢复并正常 final 时成功，工具错误不进入 finalText', () => {
    const config: CliHarnessConfig = { id: 'recovered-tool', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: mapper } }
    const { events, onEvent } = collectEvents()
    const parser = createCliParser(config, onEvent)
    parser.onLine('{"kind":"tool_error","name":"read_file","args":{"path":"missing.ts"},"data":{"text":"file not found"}}')
    expect(parser.result().finalText).toBe('')
    parser.onLine('{"kind":"message","data":{"text":"已改用可用文件恢复"}}')
    parser.onLine('{"kind":"done","data":{"text":"完成"}}')
    expect(parser.result()).toMatchObject({ ok: true, finalText: '完成' })
    expect(parser.result().error).toBeUndefined()
    expect(events).toContainEqual({ type: 'tool_call', tool: 'read_file', input: '{"path":"missing.ts"}' })
    expect(events.filter(event => event.type === 'message')).toEqual([
      { type: 'message', role: 'assistant', text: '已改用可用文件恢复' },
      { type: 'message', role: 'assistant', text: '完成' },
    ])
  })

  it('独立顶层 error 即使后续有恢复消息和 final 仍失败', () => {
    const config: CliHarnessConfig = { id: 'top-error', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: mapper } }
    const parser = createCliParser(config)
    parser.onLine('{"kind":"error","data":{"text":"run failed"}}')
    parser.onLine('{"kind":"message","data":{"text":"尝试恢复"}}')
    parser.onLine('{"kind":"done","data":{"text":"完成"}}')
    expect(parser.result()).toMatchObject({ ok: false, finalText: '完成', error: expect.stringContaining('run failed') })
  })

  it('诊断事件只记错误，不写 finalText', () => {
    const config: CliHarnessConfig = { id: 'diag-cli', kind: 'cli', command: ['diag'], output: { format: 'jsonl', events: mapper } }
    const { events, onEvent } = collectEvents()
    const parser = createCliParser(config, onEvent)
    parser.onLine('{"kind":"message","data":{"text":"ok"}}')
    parser.onLine('{"kind":"error","data":{"text":"boom"}}')
    parser.onLine('{"kind":"done","data":{"text":"ok"}}')
    const result = parser.result()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
    expect(result.finalText).toBe('ok')
    expect(events).toContainEqual({ type: 'message', role: 'system', text: 'boom' })
  })

  it.each(['tool', 'tool_result', 'usage', 'debug', 'info', 'log', 'reasoning', 'error'])('%s 的 text 不污染答案', kind => {
    const config: CliHarnessConfig = {
      id: 'guard', kind: 'cli', command: ['cli'],
      output: { format: 'jsonl', events: { ...mapper, final: { field: 'terminal', equals: 'yes' } } },
    }
    const { events, onEvent } = collectEvents()
    const parser = createCliParser(config, onEvent)
    parser.onLine(JSON.stringify({ kind: 'message', data: { text: 'answer' } }))
    parser.onLine(JSON.stringify({ kind, data: { text: 'not an answer' }, ...(kind === 'usage' ? { tokens: { input: 2 } } : {}) }))
    expect(parser.result().finalText).toBe('answer')
    if (/tool|debug|info|log|reasoning|error/.test(kind)) {
      parser.onLine(JSON.stringify({ kind, terminal: 'yes', data: { text: 'still not an answer' } }))
      expect(parser.result().finalText).toBe('answer')
    }
    expect(events.filter(event => event.type === 'message' && event.role === 'assistant')).toEqual([{ type: 'message', role: 'assistant', text: 'answer' }])
  })

  it('映射的工具即使使用 message 类型或 final 标记也不会变成答案；同一行仍提取 usage', () => {
    const parser = createCliParser({ id: 'tool', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: mapper } })
    parser.onLine(JSON.stringify({ kind: 'message', data: { text: 'answer' } }))
    for (const kind of ['message', 'done']) parser.onLine(JSON.stringify({ kind, name: 'read_file', data: { text: 'tool output' }, tokens: { input: 7, output: 3 } }))
    expect(parser.result()).toMatchObject({ finalText: 'answer', usage: { inputTokens: 7, outputTokens: 3 } })
  })

  it('最终答案可同时带用量；后续消息、诊断及工具不覆盖最终答案', () => {
    const parser = createCliParser({ id: 'final', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: mapper } })
    parser.onLine(JSON.stringify({ kind: 'done', data: { text: 'final' }, tokens: { input: 9, output: 2 } }))
    parser.onLine(JSON.stringify({ kind: 'message', data: { text: 'late' } }))
    parser.onLine(JSON.stringify({ kind: 'usage', tokens: { output: 5 }, data: { text: 'accounting' } }))
    expect(parser.result()).toMatchObject({ finalText: 'final', usage: { inputTokens: 9, outputTokens: 2 } })
  })

  it.each([
    {}, { input: 3 }, { output: 4 }, { input: -1, output: 2 },
    { input: 2, output: -1 }, { input: '2', output: 4 }, { input: 2, output: null },
  ])('不完整或无效用量 %j 不产生 Usage', tokens => {
    const { events, onEvent } = collectEvents()
    const parser = createCliParser({ id: 'usage', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: mapper } }, onEvent)
    parser.onLine(JSON.stringify({ kind: 'usage', tokens }))
    expect(parser.result().usage).toBeUndefined()
    parser.onLine('{"kind":"usage","tokens":{"input":1e999,"output":2}}')
    expect(events.filter(event => event.type === 'usage')).toEqual([])
    parser.onLine('{"kind":"usage","tokens":{"input":0,"output":0}}')
    parser.onLine(JSON.stringify({ kind: 'usage', tokens }))
    expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }])
  })

  it.each(['', '  \n', '{"kind":"message","data":{"text":"partial"}}', '{"kind":'])('配置了 final 时空流或截断流必须失败：%j', output => {
    const parser = createCliParser({ id: 'incomplete', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: mapper } })
    for (const line of output.split('\n')) parser.onLine(line)
    expect(parser.result()).toMatchObject({ ok: false, error: expect.stringContaining('missing configured final') })
  })

  it('损坏协议 JSON 即使随后出现 final 也保留失败和原文', () => {
    const parser = createCliParser({ id: 'malformed', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: mapper } })
    parser.onLine('{"kind":"message", broken}')
    parser.onLine('{"kind":"done","data":{"text":"answer"}}')
    expect(parser.result()).toMatchObject({ ok: false, finalText: 'answer', error: expect.stringContaining('Malformed protocol JSON: {"kind":"message", broken}') })
  })

  it('任意厂商消息类型支持 delta 拼接、完整消息替换及显式 final 映射', () => {
    const config: CliHarnessConfig = { id: 'vendor', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: { ...mapper, final: { field: 'state', equals: 'complete' } } } }
    const parser = createCliParser(config)
    for (const text of ['你', '好']) parser.onLine(JSON.stringify({ kind: 'vendor.reply.delta', data: { text } }))
    expect(parser.result().finalText).toBe('你好')
    parser.onLine(JSON.stringify({ kind: 'vendor.reply', data: { text: '完整消息' } }))
    expect(parser.result().finalText).toBe('完整消息')
    parser.onLine(JSON.stringify({ kind: 'vendor.reply.delta', data: { text: '！' } }))
    expect(parser.result().finalText).toBe('完整消息！')
    parser.onLine(JSON.stringify({ kind: 'vendor.catalog', state: 'complete', data: { text: '最终答案' } }))
    expect(parser.result()).toMatchObject({ ok: true, finalText: '最终答案' })
  })

  it('支持数组点路径、无 type 的文本映射和字符串工具参数，缺失映射不猜测字段', () => {
    const { events, onEvent } = collectEvents()
    const parser = createCliParser({ id: 'paths', kind: 'cli', command: ['cli'], output: { format: 'jsonl', events: { text: 'items.0.text', tool: 'call.name', toolInput: 'call.args' } } }, onEvent)
    parser.onLine('{"items":[{"text":"answer"}]}')
    parser.onLine('{"call":{"name":"bash","args":"pwd"},"items":[{"text":"tool output"}]}')
    expect(parser.result().finalText).toBe('answer')
    expect(events).toContainEqual({ type: 'tool_call', tool: 'bash', input: 'pwd' })
    const unmapped = createCliParser({ id: 'none', kind: 'cli', command: ['cli'], output: { format: 'jsonl' } })
    unmapped.onLine('{"text":"not mapped"}')
    expect(unmapped.result().finalText).toBe('')
  })

  it('text 输出的非 JSON 行按诊断记录，不写 finalText', () => {
    const config: CliHarnessConfig = { id: 'noise-cli', kind: 'cli', command: ['noise'], output: { format: 'jsonl', events: mapper } }
    const parser = createCliParser(config)
    parser.onLine('warning: something happened')
    expect(parser.result().finalText).toBe('')
  })

  it('text 输出原样作为 finalText，保留结尾换行', async () => {
    const config: CliHarnessConfig = { id: 'raw-cli', kind: 'cli', command: [node, '-e', 'process.stdout.write("line1\\nline2\\n")'], output: { format: 'text' } }
    const result = await createCliHarness(config).run(await request(), () => {})
    expect(result.finalText).toBe('line1\nline2\n')
  })
})

describe('结构化结果与失败', () => {
  it('jsonl 只从 final 文本提取 structured，工具中的 JSON 不混入', async () => {
    const lines = [
      { event: { type: 'tool', tool: 'read_file', text: '{"wrong":true}' } },
      { event: { type: 'vendor.answer', state: 'finished', text: '```json\n{"answer":42}\n```' } },
    ]
    const config: CliHarnessConfig = {
      id: 'jsonl-structured', kind: 'cli', command: [node, '-e', `for(const event of ${JSON.stringify(lines)})console.log(JSON.stringify(event))`],
      output: { format: 'jsonl', events: { type: 'event.type', tool: 'event.tool', text: 'event.text', final: { field: 'event.state', equals: 'finished' } } },
    }
    const result = await createCliHarness(config).run(await request({ resultSchema: { type: 'object' } }), () => {})
    expect(result).toMatchObject({ ok: true, structured: { answer: 42 } })
    expect(result.finalText).not.toContain('wrong')
  })

  it.each(['', '{"kind":"message"}\n', '{"kind":'])('真实子进程退出0也不能掩盖缺失 final：%j', output => {
    const config: CliHarnessConfig = {
      id: 'truncated', kind: 'cli', command: [node, '-e', `process.stdout.write(${JSON.stringify(output)})`],
      output: { format: 'jsonl', events: { type: 'kind', final: { field: 'kind', equals: 'done' } } },
    }
    return request().then(req => createCliHarness(config).run(req, () => {})).then(result => {
      expect(result).toMatchObject({ ok: false, exitCode: 0, error: expect.stringContaining('missing configured final') })
    })
  })

  it('req.resultSchema 存在时经 finalizeResult 从最终文本提取 structured', async () => {
    const script = 'process.stdout.write("前言\\n```json\\n{\\"answer\\":42}\\n```\\n")'
    const config: CliHarnessConfig = { id: 'struct-cli', kind: 'cli', command: [node, '-e', script], output: { format: 'text' } }
    const result = await createCliHarness(config).run(await request({ resultSchema: { type: 'object' } }), () => {})
    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ answer: 42 })
    expect(result.finalText).toContain('```json')
  })

  it('子进程非零退出：保留 stderr、exitCode 与 ok:false', async () => {
    const config: CliHarnessConfig = {
      id: 'fail-cli', kind: 'cli',
      command: [node, '-e', 'process.stderr.write("boom");process.exit(3)'],
      output: { format: 'text' },
    }
    const result = await createCliHarness(config).run(await request(), () => {})
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.error).toContain('boom')
  })

  it('取消：终止子进程并保留 cancelled 错误', async () => {
    const script = 'console.log(JSON.stringify({kind:"message",data:{text:"started"}}));setInterval(()=>{},1000)'
    const config: CliHarnessConfig = { id: 'cancel-cli', kind: 'cli', command: [node, '-e', script], output: { format: 'jsonl', events: { type: 'kind', text: 'data.text' } } }
    const controller = new AbortController()
    const startedAt = Date.now()
    const result = await createCliHarness(config).run(await request({ signal: controller.signal }), event => {
      if (event.type === 'message') controller.abort()
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cancelled/i)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('超时：终止子进程并保留 timeout 错误', async () => {
    const config: CliHarnessConfig = { id: 'timeout-cli', kind: 'cli', command: [node, '-e', 'setTimeout(()=>{},10000)'], output: { format: 'text' } }
    const startedAt = Date.now()
    const result = await createCliHarness(config).run(await request({ timeoutMs: 300 }), () => {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timeout/i)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it.each(['exit', 'spawn', 'cancel', 'pre-cancel', 'timeout', 'callback'] as const)('file 模式在 %s 失败后清理文件与目录并保留底层错误', async failure => {
    const req = await request()
    const promptRoot = await tempDir('takt-cli-files-')
    const controller = new AbortController()
    if (failure === 'pre-cancel') controller.abort()
    const tmpVar = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
    const previous = process.env[tmpVar]
    process.env[tmpVar] = promptRoot
    try {
      const script = failure === 'exit' ? 'process.stderr.write("HTTP 429 rate_limit");process.exit(7)'
        : 'console.log(JSON.stringify({kind:"message",text:process.argv[1]}));setInterval(()=>{},1000)'
      const config: CliHarnessConfig = {
        id: 'cleanup', kind: 'cli', promptVia: 'file',
        command: failure === 'spawn' ? [join(promptRoot, 'missing-cli'), '{{promptFile}}'] : [node, '-e', script, '{{promptFile}}'],
        output: { format: 'jsonl', events: { type: 'kind', text: 'text' } },
      }
      const result = await createCliHarness(config).run({ ...req, signal: controller.signal, timeoutMs: 500 }, event => {
        if (event.type !== 'message') return
        if (failure === 'cancel') controller.abort()
        if (failure === 'callback') throw new Error('event callback broke')
      })
      const errors = { exit: /429.*rate_limit/s, spawn: /ENOENT/, cancel: /cancelled/, 'pre-cancel': /cancelled/, timeout: /timeout/, callback: /event callback broke/ }
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(errors[failure]) })
      expect(await readdir(promptRoot)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env[tmpVar]
      else process.env[tmpVar] = previous
    }
  })

  it('provider 无映射时明确失败，不能静默使用另一家模型', async () => {
    const config: CliHarnessConfig = { id: 'provider', kind: 'cli', command: [node], output: { format: 'text' }, capabilities: { customProvider: true } }
    const result = await createCliHarness(config).run(await request({ provider: { id: 'local', protocol: 'openai-chat' } }), () => {})
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('customProvider') })
  })
})

describe('available 探测', () => {
  it.each(['relative-command', 'relative-probe', 'cwd-command', 'cwd-probe'] as const)('%s 从 projectDir 定位，探测的 cwd 仍为独立临时目录', async mode => {
    const projectDir = await tempDir('takt-cli-project-')
    await symlink(node, join(projectDir, 'local-node'))
    const executable = mode.startsWith('cwd') ? '{{cwd}}/local-node' : './local-node'
    const script = 'if(process.cwd()===process.argv[1])process.exit(2);require("fs").writeFileSync("probe-only.txt","x")'
    const config: CliHarnessConfig = {
      id: 'relative', kind: 'cli', command: [mode.endsWith('command') ? executable : node],
      available: mode.endsWith('probe') ? [executable, '-e', script, '{{cwd}}'] : undefined,
      output: { format: 'text' },
    }
    await expect(createCliHarness(config, { projectDir }).available()).resolves.toEqual({ ok: true })
    expect(await readdir(projectDir)).toEqual(['local-node'])
  })

  it('run 的相对可执行路径从 projectDir 定位，{{cwd}} 仍代表 req.cwd', async () => {
    const projectDir = await tempDir('takt-cli-project-')
    await symlink(node, join(projectDir, 'local-node'))
    const config: CliHarnessConfig = {
      id: 'relative-run', kind: 'cli', command: ['./local-node', '-e', 'process.stdout.write(process.argv[1])', '{{cwd}}'], output: { format: 'text' },
    }
    const req = await request()
    const result = await createCliHarness(config, { projectDir }).run(req, () => {})
    expect(result).toMatchObject({ ok: true, finalText: req.cwd })
  })

  it('自定义 available 命令在临时目录运行并清理，不写仓库', async () => {
    const probeRoot = await tempDir('takt-cli-probe-root-')
    const tmpVar = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
    const previous = process.env[tmpVar]
    process.env[tmpVar] = probeRoot
    try {
      const script = 'const fs=require("fs");if(process.cwd()===process.argv[1]||process.env.PROBE!=="yes")process.exit(2);fs.writeFileSync("probe.txt","x")'
      const config: CliHarnessConfig = {
        id: 'probe-cli', kind: 'cli',
        command: [node, '-e', 'setInterval(()=>{},1000)'],
        available: [node, '-e', script, '{{cwd}}'], env: { PROBE: 'yes' },
        output: { format: 'text' },
      }
      await expect(createCliHarness(config).available()).resolves.toEqual({ ok: true })
      expect(await readdir(probeRoot)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env[tmpVar]
      else process.env[tmpVar] = previous
    }
  })

  it('未配置 available 时用 command[0] --version 探测', async () => {
    const config: CliHarnessConfig = {
      id: 'version-cli', kind: 'cli',
      command: [node, '-e', 'process.exit(process.argv[1] === "--version" ? 0 : 1)'],
      output: { format: 'text' },
    }
    await expect(createCliHarness(config).available()).resolves.toEqual({ ok: true })
  })

  it('可执行文件不存在时返回原因', async () => {
    const config: CliHarnessConfig = { id: 'missing-cli', kind: 'cli', command: ['takt-definitely-missing-binary'], output: { format: 'text' } }
    const status = await createCliHarness(config).available()
    expect(status.ok).toBe(false)
    expect(status.reason).toMatch(/ENOENT|不可用/)
  })

  it('command 为空时创建即报错', () => {
    expect(() => createCliHarness({ id: 'empty', kind: 'cli', command: [], output: { format: 'text' } })).toThrow(/command/)
  })
})
