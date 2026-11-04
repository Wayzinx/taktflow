import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realDelay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessEvent, HarnessResult } from '@taktflow/core'
import { createGeminiCliHarness, createGeminiCliParser } from './gemini-cli.js'
import { createCursorAgentHarness, createCursorAgentParser } from './cursor-agent.js'
import { createQwenCodeHarness, createQwenCodeParser } from './qwen-code.js'
import { createKimiCliHarness, createKimiCliParser } from './kimi-cli.js'
import { createOpenCodeHarness, createOpenCodeParser } from './opencode.js'

// 全部输出是合成样例；只执行注入的本地 Node/shell 脚本，不调用真实 CLI、密钥或网络。
const answer = '```json\n{"done":true}\n```'
const cases = [
  { name: 'gemini-cli', create: createGeminiCliHarness, parse: createGeminiCliParser,
    args: (prompt: string) => ['-p', prompt, '--output-format', 'stream-json', '--yolo'],
    lines: [{ type: 'init', session_id: 's' }, { type: 'message', role: 'assistant', content: answer }, { type: 'result', status: 'success' }] },
  { name: 'cursor-agent', create: createCursorAgentHarness, parse: createCursorAgentParser,
    args: (_prompt: string) => ['-p', '--output-format', 'stream-json'],
    lines: [{ type: 'system', subtype: 'init', session_id: 's' }, { type: 'result', is_error: false, result: answer }] },
  { name: 'qwen-code', create: createQwenCodeHarness, parse: createQwenCodeParser,
    args: (prompt: string) => ['-p', prompt, '--output-format', 'stream-json'],
    lines: [{ type: 'system', subtype: 'init', session_id: 's' }, { type: 'result', is_error: false, result: answer }] },
  { name: 'kimi-cli', create: createKimiCliHarness, parse: createKimiCliParser,
    args: (prompt: string) => ['--print', '-p', prompt, '--output-format=stream-json'],
    lines: [{ role: 'assistant', session_id: 's', content: answer }] },
  { name: 'opencode', create: createOpenCodeHarness, parse: createOpenCodeParser,
    args: (prompt: string) => ['run', '--format', 'json', prompt],
    lines: [{ type: 'step_start', sessionID: 's' }, { type: 'text', part: { text: answer } }, { type: 'step_finish', part: { reason: 'stop' } }] },
]

let dir: string
const pids = new Set<number>()
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'takt-new-cli-')) })
afterEach(async () => {
  for (const pid of pids) {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL') } catch { /* 已回收。 */ }
  }
  pids.clear()
  await rm(dir, { recursive: true, force: true })
})

async function executable(body: string, interpreter = process.execPath): Promise<string> {
  const bin = join(dir, 'fake-cli')
  await writeFile(bin, `#!${interpreter}\n${body}\n`)
  await chmod(bin, 0o755)
  return bin
}

function output(lines: unknown[]): string {
  return `process.stdout.write(${JSON.stringify(lines.map(line => JSON.stringify(line)).join('\n'))})`
}

describe.each(cases)('$name 离线解析与真实本地子进程', adapter => {
  it('空流、日志、未知事件都不能成功，读取未完成快照不污染后续结果', () => {
    const parser = adapter.parse()
    expect(parser.result().ok).toBe(false)
    for (const line of ['', 'ordinary log', 'null', '[]', '{"type":"future","text":"not final"}']) parser.onLine(line)
    expect(parser.result()).toMatchObject({ ok: false, finalText: '' })
    adapter.lines.forEach(line => parser.onLine(JSON.stringify(line)))
    expect(parser.result()).toMatchObject({ ok: true, finalText: answer })
  })

  it.each(['429 rate limit', '503 overloaded', '401 sign in', 'ACCOUNT_SIGN_IN_REQUIRED', 'timeout'])('错误分类 %s 不被完成事件覆盖', message => {
    const parser = adapter.parse()
    parser.onLine(JSON.stringify({ type: 'error', error: { message } }))
    adapter.lines.forEach(line => parser.onLine(JSON.stringify(line)))
    expect(parser.result()).toMatchObject({ ok: false, error: expect.stringContaining(message) })
  })

  it('损坏 JSON 不洗白，事件回调异常向进程层传播', () => {
    const parser = adapter.parse()
    parser.onLine('{"type":"error","message":"broken"')
    adapter.lines.forEach(line => parser.onLine(JSON.stringify(line)))
    expect(parser.result()).toMatchObject({ ok: false, error: expect.stringContaining('Malformed protocol JSON') })
    const throwing = adapter.parse(() => { throw new Error('sink failed') })
    expect(() => throwing.onLine(JSON.stringify(adapter.lines[0]))).toThrow('sink failed')
  })

  it.each([undefined, 'local-model'])('严格按命令表传参，prompt 不经 shell，model=%s', async model => {
    const marker = join(dir, 'args.json')
    const bin = await executable(`
      const fs = require('node:fs'); let stdin = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => stdin += chunk);
      process.stdin.on('end', () => {
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),stdin,cwd:process.cwd(),value:process.env.TAKT_ADAPTER_TEST}));
        ${output(adapter.lines)};
      });
      process.stdin.resume();`)
    const prompt = 'task "literal" $HOME `echo unsafe`\n中文'
    const combined = `system\n\n${prompt}`
    const transcript = join(dir, 'transcript.jsonl')
    const events: HarnessEvent[] = []
    const result = await adapter.create({ bin }).run({ cwd: dir, prompt, model, systemAppend: 'system', resultSchema: {},
      env: { TAKT_ADAPTER_TEST: 'injected', TAKT_TRANSCRIPT: transcript }, timeoutMs: 10_000 }, e => events.push(e))
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ args: [...adapter.args(combined), ...(model ? ['--model', model] : [])],
      stdin: adapter.name === 'cursor-agent' ? combined : '', cwd: await realpath(dir), value: 'injected' })
    expect(result).toMatchObject({ ok: true, exitCode: 0, finalText: answer, sessionId: 's', structured: { done: true }, transcriptPath: transcript })
    expect(await readFile(transcript, 'utf8')).toBe(adapter.lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    expect(events.some(e => e.type === 'started')).toBe(true)
  }, 15_000)

  it('available 仅执行 --version，失败和不存在的可执行文件都不可用', async () => {
    const marker = join(dir, 'version-args.json')
    const bin = await executable(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); console.log('fake 1.0')`)
    expect(await adapter.create({ bin }).available()).toEqual({ ok: true })
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual(['--version'])
    await executable('console.error("version failed"); process.exitCode = 2')
    expect(await adapter.create({ bin }).available()).toMatchObject({ ok: false, reason: expect.stringContaining('version failed') })
    expect(await adapter.create({ bin: join(dir, 'missing') }).available()).toMatchObject({ ok: false, reason: expect.stringContaining('ENOENT') })
  }, 15_000)

  it('退出 0 的空流仍失败，非零退出保留已解析文本和 stderr', async () => {
    const bin = await executable('')
    expect(await adapter.create({ bin }).run({ cwd: dir, prompt: '' }, () => {})).toMatchObject({ ok: false, exitCode: 0, error: expect.stringContaining('Incomplete') })
    await executable(`${output(adapter.lines)}; console.error('HTTP 503 overloaded'); process.exitCode = 7`)
    const result = await adapter.create({ bin }).run({ cwd: dir, prompt: '' }, () => {})
    expect(result).toMatchObject({ ok: false, finalText: answer, exitCode: 7, error: expect.stringContaining('503') })
    expect(result.error).toContain('overloaded')
    expect(result).not.toHaveProperty('structured')
  }, 15_000)

  it.each(['cancel', 'timeout', 'signal'])('%s 回收进程且不能返回成功', async mode => {
    const lines = adapter.lines.map(line => `'${JSON.stringify(line).replaceAll("'", "'\\''")}'`).join(' ')
    const bin = await executable(`printf '%s\\n' ${lines}
      printf '{"type":"local_ready","pid":%s}\\n' "$$"
      while :; do sleep 1; done`, '/bin/sh')
    const controller = new AbortController()
    let pending: Promise<HarnessResult> | undefined
    if (mode === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      pending = adapter.create({ bin }).run({ cwd: dir, prompt: '', signal: controller.signal, timeoutMs: 30_000 }, event => {
        if (event.type !== 'message' || !event.text.includes('local_ready')) return
        const pid = (JSON.parse(event.text) as { pid: number }).pid
        pids.add(pid)
      })
      void pending.then(() => { settled = true }, () => { settled = true })
      // 真实 I/O 确认启动后才触发停止，不把并发负载下的启动时间算作超时行为。
      const deadline = Date.now() + 10_000
      while (pids.size === 0 && !settled && Date.now() < deadline) await realDelay(10)
      expect(pids.size).toBe(1)
      for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow()
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(30_000)
      else if (mode === 'cancel') controller.abort()
      else for (const pid of pids) process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM')
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.error).toContain(mode === 'signal' ? 'SIGTERM' : mode === 'cancel' ? 'cancelled' : 'timeout')
      expect(pids.size).toBe(1)
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      controller.abort()
      try {
        // 断言失败时也让 SIGKILL 升级 timer 生效，并等 close 后再恢复时钟。
        if (mode === 'timeout') await vi.advanceTimersByTimeAsync(5_000)
        await pending
      } finally {
        if (mode === 'timeout') vi.useRealTimers()
      }
    }
  }, 20_000)

  it('预取消、customProvider 和 resume 不支持时均不启动任务', async () => {
    const marker = join(dir, 'spawned')
    const bin = await executable(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`)
    const harness = adapter.create({ bin })
    const controller = new AbortController()
    controller.abort()
    expect(await harness.run({ cwd: dir, prompt: '', signal: controller.signal }, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('cancelled before spawn') })
    expect(await harness.run({ cwd: dir, prompt: '', provider: { id: 'test', protocol: 'openai-chat' } }, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('customProvider') })
    expect(await harness.run({ cwd: dir, prompt: '', sessionId: 'old' }, () => {})).toMatchObject({ ok: false, error: expect.stringContaining('resume') })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(harness.capabilities).toMatchObject({ toolEvents: true, usage: true, resume: false, customProvider: false, structuredOutput: false,
      sandbox: false, mcp: false, compactionEvents: false, cost: ['cursor-agent', 'qwen-code', 'opencode'].includes(adapter.name) })
  })
})
