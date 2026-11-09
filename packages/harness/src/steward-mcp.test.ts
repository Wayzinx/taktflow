import { readFile, stat, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { beforeEach, expect, it, vi } from 'vitest'
import { createClaudeCodeHarness } from './claude-code.js'
import { createCodexHarness } from './codex.js'
import { runProcess } from './process.js'
import { collectSecrets, createRedactor } from './redact.js'
import type { HarnessRequest } from '@taktflow/core'
vi.mock('./process.js', async original => ({ ...await original<typeof import('./process.js')>(), runProcess: vi.fn() }))
const request: HarnessRequest = { cwd: tmpdir(), prompt: '查看进度', readOnly: true, mcpServers: [{ name: 'takt', url: 'http://127.0.0.1:1234/api/steward/mcp', headers: { Authorization: 'Bearer test-turn-secret' } }] }
beforeEach(() => vi.mocked(runProcess).mockReset())
it.each([false, true])('Claude MCP 配置只放行 takt，临时文件在成功或异常后删除（异常=%s）', async failure => {
  let configFile = ''
  vi.mocked(runProcess).mockImplementationOnce(async (_bin, args, _req, options) => {
    configFile = args[args.indexOf('--mcp-config') + 1]!
    expect(configFile.startsWith(tmpdir())).toBe(true)
    expect((await stat(configFile)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({ mcpServers: { takt: { type: 'http', url: request.mcpServers![0]!.url, headers: request.mcpServers![0]!.headers } } })
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__takt__*')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args.join(' ')).not.toContain('test-turn-secret')
    if (failure) throw new Error('mock failure')
    options?.onLine?.('{"type":"result","result":"完成"}')
    return { ok: true, stdout: '', stderr: '' }
  })
  const result = createClaudeCodeHarness().run(request, () => {})
  if (failure) await expect(result).rejects.toThrow('mock failure')
  else expect((await result).ok).toBe(true)
  await expect(access(configFile)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('Codex MCP 令牌只进入子进程环境，使用只读沙箱且关闭 shell', async () => {
  const original = structuredClone(request)
  vi.mocked(runProcess).mockImplementationOnce(async (_bin, args, req, options) => {
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(args).toContain('mcp_servers.takt.url="http://127.0.0.1:1234/api/steward/mcp"')
    expect(args).toContain('mcp_servers.takt.bearer_token_env_var="TAKT_MCP_TOKEN_0"')
    expect(args).toContain('features.shell_tool=false')
    expect(req.env?.TAKT_MCP_TOKEN_0).toBe('test-turn-secret')
    expect(args.join(' ')).not.toContain('test-turn-secret')
    options?.onLine?.('{"type":"turn.completed"}')
    return { ok: true, stdout: '', stderr: '' }
  })
  expect((await createCodexHarness().run(request, () => {})).ok).toBe(true)
  expect(request).toEqual(original)
  expect(process.env.TAKT_MCP_TOKEN_0).toBeUndefined()
  expect(createRedactor(collectSecrets(request))('test-turn-secret')).toBe('[REDACTED]')
})
