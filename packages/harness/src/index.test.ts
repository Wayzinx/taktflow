import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarnesses, createClaudeCodeHarness, createClaudeCodeParser, createCodexHarness, createCodexParser,
  createDshHarness, createDshParser, createMockHarness, loadMockScript, extractJsonBlock, finalizeResult, runProcess } from './index.js'

vi.mock('./process.js', async importOriginal => ({
  ...await importOriginal<typeof import('./process.js')>(), runProcess: vi.fn(),
}))
beforeEach(() => {
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcess).mockResolvedValue({ ok: true, stdout: '', stderr: '', exitCode: 0 })
  vi.stubEnv('DSH_BIN', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('harness exports', () => {
  it('默认包含四个适配器，空 mock 脚本可直接使用；创建时不探测 CLI', async () => {
    const harnesses = createHarnesses()
    expect(Object.keys(harnesses)).toEqual(['mock', 'claude-code', 'codex', 'dsh'])
    for (const [id, adapter] of Object.entries(harnesses)) expect(adapter.id).toBe(id)
    expect(await harnesses.mock!.run({ prompt: 'task', cwd: tmpdir() }, () => {})).toMatchObject({ ok: true, finalText: '(mock) no step matched' })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('传递 mockScript 和所有 CLI 的独立配置', async () => {
    const harnesses = createHarnesses({
      mockScript: { steps: [{ finalText: 'configured' }] },
      claudeCode: { bin: '/configured/claude' }, codex: { bin: '/configured/codex' },
      dsh: { bin: '/configured/dsh', probeTimeoutMs: 123 },
    })
    expect((await harnesses.mock!.run({ prompt: 'task', cwd: tmpdir() }, () => {})).finalText).toBe('configured')
    await harnesses['claude-code']!.available()
    await harnesses.codex!.available()
    await harnesses.dsh!.available()
    expect(vi.mocked(runProcess).mock.calls.map(call => call[0])).toEqual(['/configured/claude', '/configured/codex', '/configured/dsh'])
    expect(vi.mocked(runProcess).mock.calls[2]?.[2].timeoutMs).toBe(123)
  })

  it('从统一出口导出所有工厂、parser、mock loader 和 process 工具', () => {
    for (const exported of [createClaudeCodeHarness, createCodexHarness, createDshHarness, createMockHarness,
      createClaudeCodeParser, createCodexParser, createDshParser, loadMockScript, extractJsonBlock, finalizeResult]) {
      expect(exported).toBeTypeOf('function')
    }
  })
})
