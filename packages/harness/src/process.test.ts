import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as childProcess from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessRequest } from '@taktflow/core'
import { extractJsonBlock, finalizeResult, runProcess } from './process.js'
import type { ProcessOptions } from './process.js'

// 保留真实 I/O；仅让故障注入可替换 ESM 中原本不可配置的命名导出。
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }))

let dir: string
const pids = new Set<number>()
const aliveCode = 'console.log(`pid:${process.pid}`); setInterval(() => {}, 1000)'

function request(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return { cwd: dir, prompt: 'test', ...overrides }
}

function run(code: string, overrides: Partial<HarnessRequest> = {}, options: ProcessOptions = {}) {
  return runProcess(process.execPath, ['-e', code], request(overrides), {
    ...options,
    onLine(line) {
      const pid = /^pid:(\d+)$/.exec(line)
      if (pid) pids.add(Number(pid[1]))
      options.onLine?.(line)
    },
  })
}

function expectReaped() {
  expect(pids.size).toBeGreaterThan(0)
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
}

beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'takt-process-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  for (const pid of pids) {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL') } catch { /* 已回收。 */ }
  }
  pids.clear()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('runProcess', () => {
  it('逐行读取 NDJSON、空行与未换行末行，并等待 transcript 追加落盘', async () => {
    const path = join(dir, 'nested', 'transcript.jsonl')
    const lines: string[] = []
    const text = '{"text":"你好"}\n\n{"done":true}'
    const first = await run(`process.stdout.write(${JSON.stringify(text)})`, { env: { TAKT_TRANSCRIPT: path } }, { onLine: line => lines.push(line) })
    expect(first).toMatchObject({ ok: true, stdout: text, stderr: '', exitCode: 0, transcriptPath: path })
    expect(lines).toEqual(['{"text":"你好"}', '', '{"done":true}'])
    expect(await fs.readFile(path, 'utf8')).toBe(`${text}\n`)
    await run('console.log("next")', { env: { TAKT_TRANSCRIPT: path } })
    expect(await fs.readFile(path, 'utf8')).toBe(`${text}\nnext\n`)
  })

  it('跨数据块 UTF8 不损坏，CRLF 只产生一行', async () => {
    const lines: string[] = []
    const result = await run('const b = Buffer.from("你\\r\\n好"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 20)', {}, { onLine: line => lines.push(line) })
    expect(result.stdout).toBe('你\r\n好')
    expect(lines).toEqual(['你', '好'])
    expect(result.transcriptPath).toBeUndefined()
  })

  it.each([undefined, '', '输入\nsecond line'])('stdin 为 %s 时可读至 EOF', async stdin => {
    const result = await run('let data = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => data += c); process.stdin.on("end", () => console.log(JSON.stringify(data))); process.stdin.resume()', {}, { stdin })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.stdout)).toBe(stdin ?? '')
  })

  it('设置 cwd 并继承和覆盖环境变量', async () => {
    const result = await run('console.log(JSON.stringify({cwd:process.cwd(), value:process.env.TAKT_PROCESS_TEST, path:process.env.PATH}))', { env: { TAKT_PROCESS_TEST: 'injected' } })
    expect(JSON.parse(result.stdout)).toEqual({ cwd: await fs.realpath(dir), value: 'injected', path: process.env.PATH })
  })

  it('非零退出同时保留 stdout、stderr 和退出码', async () => {
    const result = await run('console.log("partial"); console.error("request 429 rejected"); process.exitCode = 7')
    expect(result).toMatchObject({ ok: false, stdout: 'partial\n', stderr: 'request 429 rejected\n', exitCode: 7 })
    expect(result.error).toContain('429')
    expect(result.error).toContain('7')
  })

  it('失败 stderr 的普通诊断进入最终 error，成功 warning 不会导致失败', async () => {
    const failed = await run('console.error("permission denied: /private/file"); process.exitCode = 1')
    const final = finalizeResult(request(), { ok: true, finalText: '' }, failed)
    expect(final).toMatchObject({ ok: false, error: expect.stringContaining('permission denied: /private/file') })
    const success = await run('console.error("warning: optional config missing")')
    expect(success).toMatchObject({ ok: true, stderr: 'warning: optional config missing\n' })
    expect(success.error).toBeUndefined()
  })

  it('ENOENT 以返回值报告并关闭 transcript', async () => {
    const path = join(dir, 'transcript')
    const result = await runProcess(join(dir, 'missing-command'), [], request({ env: { TAKT_TRANSCRIPT: path } }))
    expect(result).toMatchObject({ ok: false, spawnErrorCode: 'ENOENT', transcriptPath: path })
    expect(result.error).toContain('ENOENT')
    expect(await fs.readFile(path, 'utf8')).toBe('')
  })

  it('同步 spawn 参数错误也返回失败', async () => {
    expect(await runProcess('bad\0command', [], request())).toMatchObject({ ok: false, error: expect.stringContaining('Process setup failed') })
  })

  it('预取消不启动进程也不创建 transcript', async () => {
    const controller = new AbortController()
    controller.abort()
    const marker = join(dir, 'started')
    const path = join(dir, 'log')
    const result = await run(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`, { signal: controller.signal, env: { TAKT_TRANSCRIPT: path } })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('cancelled before spawn') })
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('运行后取消并回收进程、移除 abort listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = await run(aliveCode, { signal: controller.signal }, { onLine: () => controller.abort() })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expectReaped()
  })

  it('超时先 TERM，并等待进程关闭', async () => {
    const result = await run(aliveCode, { timeoutMs: 300 })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('timeout') })
    expect(result.error).toContain('SIGTERM')
    expectReaped()
  })

  it('TERM 被忽略时五秒后升级 KILL，不提前返回', async () => {
    const controller = new AbortController()
    let abortAt = 0
    const result = await run(`process.on('SIGTERM', () => {}); ${aliveCode}`, { signal: controller.signal }, {
      onLine() { abortAt = Date.now(); controller.abort() },
    })
    expect(Date.now() - abortAt).toBeGreaterThanOrEqual(4_900)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('SIGKILL') })
    expectReaped()
  }, 12_000)

  it.skipIf(process.platform === 'win32')('父进程已退出时也回收继承 stdout 管道的后代', async () => {
    const controller = new AbortController()
    const descendant = 'console.log(`pid:${process.pid}`); setTimeout(() => console.log("ready"), 150); setInterval(() => {}, 1000)'
    const code = `console.log(\`pid:\${process.pid}\`); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 1, 2]}); process.exit(0)`
    const result = await run(code, { signal: controller.signal, timeoutMs: 2_000 }, {
      onLine(line) { if (line === 'ready') controller.abort() },
    })
    expect(result).toMatchObject({ ok: false, exitCode: 0, error: expect.stringContaining('cancelled') })
    expect(pids.size).toBe(2)
    await expect.poll(() => [...pids].every(pid => {
      try { process.kill(pid, 0); return false } catch { return true }
    }), { timeout: 2_000 }).toBe(true)
  })

  it('默认超时为三十分钟，正常退出会清理 timer 和 listener', async () => {
    const controller = new AbortController()
    const set = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    expect((await run('console.log("done")', { signal: controller.signal })).ok).toBe(true)
    const index = set.mock.calls.findIndex(call => call[1] === 30 * 60_000)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(clear).toHaveBeenCalledWith(set.mock.results[index]!.value)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('onLine 抛错转为失败且仍保存原始行、回收进程', async () => {
    const path = join(dir, 'log')
    const result = await run(aliveCode, { env: { TAKT_TRANSCRIPT: path } }, { onLine() { throw new Error('parser broke') } })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('parser broke') })
    expect(await fs.readFile(path, 'utf8')).toBe(result.stdout)
    expectReaped()
  })

  it('stdin EPIPE 转为失败并回收进程', async () => {
    const result = await run(`require('node:fs').closeSync(0); ${aliveCode}`, {}, { stdin: 'x'.repeat(8 * 1024 * 1024) })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/EPIPE|ECONNRESET/) })
    // 写端错误可能早于首行到达，runProcess 的 close 已确认进程退出。
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
  })

  it('transcript 创建失败不会启动进程', async () => {
    const path = join(dir, 'file')
    await fs.writeFile(path, 'not a directory')
    const result = await run(aliveCode, { env: { TAKT_TRANSCRIPT: join(path, 'log') } })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Transcript open failed') })
    expect(pids.size).toBe(0)
  })

  it('transcript 中途写入失败会回收进程并关闭文件', async () => {
    const original = fs.open
    let close: ReturnType<typeof vi.spyOn> | undefined
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      vi.spyOn(handle, 'appendFile').mockRejectedValue(new Error('ENOSPC disk full'))
      close = vi.spyOn(handle, 'close')
      return handle
    })
    const result = await run(aliveCode, { env: { TAKT_TRANSCRIPT: join(dir, 'log') } })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('ENOSPC') })
    expect(close).toHaveBeenCalledOnce()
    expectReaped()
  })

  it('close 后异步 transcript 写入失败仍等待 flush，且不创建五秒升级 timer', async () => {
    const originalOpen = fs.open
    const originalSpawn = childProcess.spawn
    let closed = false
    let release!: () => void
    const afterClose = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(childProcess, 'spawn').mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      const child = originalSpawn(...args)
      child.once('close', () => { closed = true; release() })
      return child
    })
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      vi.spyOn(handle, 'appendFile').mockImplementation(async () => {
        await afterClose
        expect(closed).toBe(true)
        throw new Error('late write failure')
      })
      return handle
    })
    const set = vi.spyOn(globalThis, 'setTimeout')
    const result = await run('console.log("done")', { env: { TAKT_TRANSCRIPT: join(dir, 'log') } })
    expect(result).toMatchObject({ ok: false, exitCode: 0, stdout: 'done\n', error: expect.stringContaining('late write failure') })
    expect(set.mock.calls.some(call => call[1] === 5_000)).toBe(false)
  })

  it.each(['rate limit', 'overloaded', 'sign in', 'ACCOUNT_SIGN_IN_REQUIRED', 'timeout', 'HTTP 429', 'status: 503', '{"error_code":401}'])('退出 0 仍保留明确降级错误 %s', async keyword => {
    const result = await run(`console.log(${JSON.stringify(keyword)}); console.error(${JSON.stringify(keyword)})`)
    expect(result.ok).toBe(false)
    expect(result.error?.toLowerCase()).toContain(keyword.match(/429|503|401/)?.[0] ?? keyword.toLowerCase())
  })

  it('有事件解析器且退出 0 时，stdout 里的工具输出提到 timeout / rate limit 不算降级错误', async () => {
    const lines: string[] = []
    const code = 'console.log(JSON.stringify({type:"tool_result",content:"API_TIMEOUT_MS=600000; on timeout or rate limit retry"}))'
    const result = await run(code, {}, { onLine: line => lines.push(line) })
    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(result.error).toBeUndefined()
    expect(lines).toHaveLength(1)
    const stderr = await run(`${code}; console.error("Request timeout")`, {}, { onLine: () => {} })
    expect(stderr).toMatchObject({ ok: false, error: expect.stringMatching(/timeout/i) })
  })

  it('不把外层 Claude Code 会话的标记和消息令牌传给子进程；请求显式给的照传', async () => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'host-session'); vi.stubEnv('CLAUDE_CODE_MESSAGING_TOKEN', 'host-token'); vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('TAKT_KEEP', 'kept')
    try {
      const code = 'console.log(JSON.stringify({ s: process.env.CLAUDE_CODE_SESSION_ID, t: process.env.CLAUDE_CODE_MESSAGING_TOKEN, c: process.env.CLAUDECODE, k: process.env.TAKT_KEEP }))'
      expect(JSON.parse((await run(code)).stdout)).toEqual({ k: 'kept' })
      expect(JSON.parse((await run(code, { env: { CLAUDECODE: 'explicit' } })).stdout)).toEqual({ c: 'explicit', k: 'kept' })
    } finally { vi.unstubAllEnvs() }
  })

  it('成功文本偶然包含数字不会误判为错误', async () => {
    const result = await run('console.log(JSON.stringify({input_tokens:429, output_tokens:503, cached_tokens:401})); console.log("processed 429 files and 503 records; see page 401")')
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })
})

describe('JSON 结果合并', () => {
  const block = (value: string) => `\`\`\`json\n${value}\n\`\`\``
  it.each(['null', 'false', '0', '[]', '{"ok":true}'])('解析合法 JSON %s', value => {
    expect(extractJsonBlock(block(value))).toEqual(JSON.parse(value))
  })
  it('只使用最后一个块，末块无效或未闭合时不回退', () => {
    expect(extractJsonBlock(`${block('{"old":true}')}\n${block('{"new":true}')}`)).toEqual({ new: true })
    expect(extractJsonBlock(`${block('{}')}\n${block('{broken}')}`)).toBeUndefined()
    expect(extractJsonBlock(`${block('{}')}\n\`\`\`json\n{}`)).toBeUndefined()
    expect(extractJsonBlock('plain text')).toBeUndefined()
  })
  it('只有请求有 schema 才填结构化值，原生解析结果优先于文本', () => {
    const parsed = { ok: true, finalText: block('{"value":1}'), structured: { stale: true } }
    const proc = { ok: true, stdout: block('{"wrong":true}'), stderr: '', exitCode: 0, transcriptPath: '/tmp/log' }
    expect(finalizeResult(request(), parsed, proc)).not.toHaveProperty('structured')
    expect(finalizeResult(request({ resultSchema: {} }), parsed, proc)).toMatchObject({ ok: true, structured: { stale: true }, exitCode: 0, transcriptPath: '/tmp/log' })
  })
  it('合并两层失败原因并保留进程元数据', () => {
    expect(finalizeResult(request(), { ok: false, finalText: 'partial', error: 'parse failed' }, { ok: false, stdout: '', stderr: '', error: 'HTTP 429', exitCode: 2, transcriptPath: '/tmp/log' }))
      .toMatchObject({ ok: false, error: 'parse failed\nHTTP 429', exitCode: 2, transcriptPath: '/tmp/log' })
    expect(finalizeResult(request(), { ok: false, finalText: '' }, { ok: true, stdout: '', stderr: '' }).ok).toBe(false)
    expect(finalizeResult(request(), { ok: true, finalText: '' }, { ok: false, stdout: '', stderr: '' }).ok).toBe(false)
  })
  it('schema 请求缺少或无法解析最后 JSON 块时留给引擎校验', () => {
    const proc = { ok: true, stdout: '', stderr: '' }
    expect(finalizeResult(request({ resultSchema: {} }), { ok: true, finalText: block('bad') }, proc)).toMatchObject({ ok: true, structured: undefined })
    expect(finalizeResult(request({ resultSchema: { type: 'object' } }), { ok: true, finalText: block('false') }, proc)).toMatchObject({ ok: true, structured: false })
  })
})
