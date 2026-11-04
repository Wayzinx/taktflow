import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as childProcess from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessEvent, HarnessRequest } from '@taktflow/core'
import { createClaudeCodeHarness } from '../claude-code.js'
import { createCodexHarness } from '../codex.js'
import { createDshHarness } from '../dsh.js'
import { createMockHarness } from '../mock.js'
import { finalizeResult, runProcess } from '../process.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }))

let dir: string
const keyName = 'TAKT_REDACTION_TEST_VALUE'
const secret = 'fake-only-credential'
function request(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return { cwd: dir, prompt: '', provider: { id: 'test', protocol: 'anthropic-messages', apiKeyEnv: keyName }, env: { [keyName]: secret }, ...overrides }
}
function run(code: string, req: HarnessRequest = request(), onLine?: (line: string) => void) {
  return runProcess(process.execPath, ['-e', code], req, { onLine })
}
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'takt-existing-redaction-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(dir, { force: true, recursive: true })
})

describe('process redaction', () => {
  it.each(['xy', '123', '引号"反斜线\\密钥', 'abc\tdef', '"', '\\'])('短值与转义字符均保护且 JSONL 保持有效: %j', async value => {
    const path = join(dir, 'transcript')
    const raw = [JSON.stringify({ text: `prefix ${value} suffix` }), JSON.stringify({ nested: [value] })].join('\r\n')
    const lines: string[] = []
    const result = await run(`process.stdout.write(${JSON.stringify(raw)}); process.stderr.write(process.env[${JSON.stringify(keyName)}]); process.exitCode = 2`,
      request({ env: { [keyName]: value, TAKT_TRANSCRIPT: path } }), line => lines.push(line))
    expect(result.ok).toBe(false)
    expect(lines.map(line => JSON.parse(line))).toEqual([{ text: 'prefix [REDACTED] suffix' }, { nested: ['[REDACTED]'] }])
    expect(result.stdout.split('\r\n').map(line => JSON.parse(line))).toEqual(lines.map(line => JSON.parse(line)))
    expect(result.stderr).toBe('[REDACTED]')
    expect(result.error).toContain('[REDACTED]')
    expect((await fs.readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))).toEqual(lines.map(line => JSON.parse(line)))
  })

  it('分块密钥、UTF8 逐字节、纯文本末行无换行都不泄露或损坏', async () => {
    const path = join(dir, 'transcript')
    const text = `中文🙂 ${secret} 结束`
    const code = `const b = Buffer.from(${JSON.stringify(text)}); let i = 0; const timer = setInterval(() => { process.stdout.write(b.subarray(i, ++i)); if (i === b.length) clearInterval(timer) }, 1)`
    const lines: string[] = []
    const result = await run(code, request({ env: { [keyName]: secret, TAKT_TRANSCRIPT: path } }), line => lines.push(line))
    expect(result).toMatchObject({ ok: true, stdout: '中文🙂 [REDACTED] 结束' })
    expect(lines).toEqual(['中文🙂 [REDACTED] 结束'])
    expect(await fs.readFile(path, 'utf8')).toBe('中文🙂 [REDACTED] 结束\n')
  })

  it('已知多行值在逐行回调与落盘前保护每一段', async () => {
    const value = 'first-private-part\nsecond-private-part'
    const path = join(dir, 'transcript')
    const lines: string[] = []
    const result = await run(`process.stdout.write(${JSON.stringify(value)}); process.stderr.write(${JSON.stringify(value)})`,
      request({ env: { [keyName]: value, TAKT_TRANSCRIPT: path } }), line => lines.push(line))
    expect(result.stdout).toBe('[REDACTED]\n[REDACTED]')
    expect(result.stderr).toBe('[REDACTED]\n[REDACTED]')
    expect(lines).toEqual(['[REDACTED]', '[REDACTED]'])
    expect(await fs.readFile(path, 'utf8')).toBe('[REDACTED]\n[REDACTED]\n')
  })

  it('从 process.env 和 req.env 同时收集敏感值及自定义 provider 变量', async () => {
    vi.stubEnv(keyName, 'inherited-private')
    vi.stubEnv('TAKT_TEST_API_KEY', 'inherited-api-value')
    const values = [secret, 'inherited-private', 'inherited-api-value', 'req-token', 'req-password', 'req-secret']
    const result = await run(`console.log(${JSON.stringify(values.join(' '))})`, request({ env: {
      [keyName]: secret, TAKT_TEST_AUTH_TOKEN: 'req-token', TAKT_TEST_DB_PASSWORD: 'req-password', TAKT_TEST_CLIENT_SECRET: 'req-secret',
    } }))
    expect(result.stdout.trim()).toBe(values.map(() => '[REDACTED]').join(' '))
  })

  it('无环境来源的常见密钥形状也在 stdout/stderr/回调/transcript 脱敏', async () => {
    const values = ['sk-fake_only_123456', 'ghp_abcdefghijklmnop1234', 'github_pat_abcdefghijklmnop1234',
      'AKIA1234567890ABCDEF', 'AIza1234567890abcdefghijklmnop', 'xoxb-1234567890-fake',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.signaturefake', 'Bearer opaque-fake-token-1234']
    const path = join(dir, 'transcript')
    const raw = JSON.stringify({ values })
    const lines: string[] = []
    const result = await run(`process.stdout.write(${JSON.stringify(raw)}); process.stderr.write(${JSON.stringify(raw)})`,
      { cwd: dir, prompt: '', env: { TAKT_TRANSCRIPT: path } }, line => lines.push(line))
    for (const output of [result.stdout, result.stderr, ...lines, await fs.readFile(path, 'utf8')]) {
      expect(JSON.parse(output)).toEqual({ values: values.map(() => '[REDACTED]') })
    }
  })

  it('JSON Unicode 转义在解码后脱敏，同时保留普通文本和数字用量', async () => {
    const raw = '{"text":"\\u0078\\u0079","usage":{"input_tokens":123,"output_tokens":4},"ordinary":"hello"}'
    const lines: string[] = []
    const result = await run(`console.log(${JSON.stringify(raw)})`, request({ env: { [keyName]: 'xy' } }), line => lines.push(line))
    expect(JSON.parse(result.stdout)).toEqual({ text: '[REDACTED]', usage: { input_tokens: 123, output_tokens: 4 }, ordinary: 'hello' })
    expect(JSON.parse(lines[0]!)).toEqual(JSON.parse(result.stdout))
  })

  it('callback 抛错的密钥只以脱敏错误返回', async () => {
    const result = await run('console.log("ready"); setInterval(() => {}, 1000)', request(), () => { throw new Error(`callback failed ${secret}`) })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('onLine failed: callback failed [REDACTED]') })
    expect(result.error).not.toContain(secret)
  })

  it('同步 setup 异常和 spawn ENOENT 异常保护路径中的密钥', async () => {
    const missing = await runProcess(join(dir, secret), [], request())
    expect(missing).toMatchObject({ ok: false, spawnErrorCode: 'ENOENT' })
    expect(missing.error).toContain('[REDACTED]')
    expect(missing.error).not.toContain(secret)
    vi.spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error(`setup failed ${secret}`) })
    const setup = await run('')
    expect(setup).toMatchObject({ ok: false, error: 'Process setup failed: setup failed [REDACTED]' })
  })

  it('transcript open 早返回保护错误路径且不启动子进程', async () => {
    const blocker = join(dir, secret)
    await fs.writeFile(blocker, 'file')
    const spawn = vi.spyOn(childProcess, 'spawn')
    const result = await run('', request({ env: { [keyName]: secret, TAKT_TRANSCRIPT: join(blocker, 'log') } }))
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Transcript open failed') })
    expect(result.error).toContain('[REDACTED]')
    expect(result.error).not.toContain(secret)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['appendFile', 'close'] as const)('transcript %s 异常保护错误内容', async method => {
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      const close = handle.close.bind(handle)
      if (method === 'close') vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error(`close ${secret}`) })
      else vi.spyOn(handle, 'appendFile').mockRejectedValue(new Error(`write ${secret}`))
      return handle
    })
    const result = await run('console.log("done")', request({ env: { [keyName]: secret, TAKT_TRANSCRIPT: join(dir, 'log') } }))
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('[REDACTED]') })
    expect(result.error).not.toContain(secret)
  })

  it('超时结束时刷新无换行末尾，仍保持脱敏', async () => {
    const lines: string[] = []
    const result = await run(`process.stdout.write(${JSON.stringify(secret)}); setInterval(() => {}, 1000)`, request({ timeoutMs: 300 }), line => lines.push(line))
    expect(result).toMatchObject({ ok: false, stdout: '[REDACTED]', error: expect.stringContaining('timeout') })
    expect(lines).toEqual(['[REDACTED]'])
  })

  it('finalizeResult 对解析文本、session、错误和 structured 统一脱敏', () => {
    const finalText = `\`\`\`json\n${JSON.stringify({ key: secret })}\n\`\`\``
    const result = finalizeResult(request({ resultSchema: {} }), { ok: false, finalText, error: `parsed ${secret}`, sessionId: secret },
      { ok: false, stdout: '', stderr: '', error: `process ${secret}` })
    expect(result).toMatchObject({ ok: false, sessionId: '[REDACTED]', structured: { key: '[REDACTED]' } })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe('adapter events use redacted process lines', () => {
  it.each(['claude', 'codex', 'dsh'])('%s 的事件与最终文本不泄露转义密钥', async kind => {
    const value = 'fake"\\value'
    const output = kind === 'claude' ? [
      { type: 'assistant', message: { content: [{ type: 'text', text: value }, { type: 'tool_use', id: 't', name: 'Read', input: { key: value } }] } },
      { type: 'result', result: value },
    ] : kind === 'codex' ? [
      { type: 'item.completed', item: { type: 'agent_message', text: value } }, { type: 'turn.completed' },
    ] : [{ type: 'text', text: value }, { type: 'final', text: value }]
    const bin = join(dir, 'fake-cli')
    await fs.writeFile(bin, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(output.map(event => JSON.stringify(event)).join('\n'))}));\n`, { mode: 0o700 })
    const harness = kind === 'claude' ? createClaudeCodeHarness({ bin }) : kind === 'codex' ? createCodexHarness({ bin }) : createDshHarness({ bin })
    const events: HarnessEvent[] = []
    const result = await harness.run({ cwd: dir, prompt: 'test', env: { TEST_API_KEY: value } }, event => events.push(event))
    expect(result).toMatchObject({ ok: true, finalText: '[REDACTED]' })
    expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '[REDACTED]' })
    expect(JSON.stringify(events)).not.toContain(JSON.stringify(value).slice(1, -1))
  })

  it('mock 的事件、工具和压缩记录也遵守相同脱敏规则', async () => {
    const events: HarnessEvent[] = []
    const harness = createMockHarness({ steps: [{ finalText: secret, fail: `failed ${secret}`,
      toolCalls: [{ tool: 'read', input: secret, output: secret }],
      compaction: { beforeTokens: 5, afterTokens: 1, summary: secret, dropped: [secret] },
    }] })
    const result = await harness.run({ cwd: dir, prompt: '', env: { TEST_API_KEY: secret } }, event => events.push(event))
    expect(result).toMatchObject({ ok: false, finalText: '[REDACTED]', error: 'failed [REDACTED]' })
    expect(events).toContainEqual({ type: 'tool_call', tool: 'read', input: '[REDACTED]', output: '[REDACTED]' })
    expect(events).toContainEqual({ type: 'compacted', record: { beforeTokens: 5, afterTokens: 1, summary: '[REDACTED]', dropped: ['[REDACTED]'], at: expect.any(String), trigger: 'auto' } })
    expect(JSON.stringify(events)).not.toContain(secret)
  })
})
