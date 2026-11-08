import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaktConfig } from '@taktflow/core'
import { createHarnesses, harnessCommand } from '../index.js'
import { runProcess } from '../process.js'

vi.mock('../process.js', async original => ({ ...await original<typeof import('../process.js')>(), runProcess: vi.fn() }))
beforeEach(() => { vi.mocked(runProcess).mockReset(); vi.mocked(runProcess).mockResolvedValue({ ok: true, stdout: '', stderr: '', exitCode: 0 }) })
afterEach(() => vi.unstubAllEnvs())
const config = (): TaktConfig => ({ project: { name: 'test' }, workflows: [] })
const builtins = ['claude-code', 'codex', 'dsh', 'gemini-cli', 'cursor-agent', 'qwen-code', 'kimi-cli', 'opencode', 'pi']

it.each(builtins)('%s 的命令与环境覆盖同时用于探测和运行', async id => {
  const c = config(); c.harnessOverrides = { [id]: { command: '/custom/tool', env: { OVERRIDE: 'yes', PRIORITY: 'config' } } }
  const harness = createHarnesses({ config: c })[id]!
  expect(harnessCommand(harness)).toEqual(['/custom/tool'])
  await harness.available()
  expect(vi.mocked(runProcess).mock.calls[0]?.[0]).toBe('/custom/tool')
  expect(vi.mocked(runProcess).mock.calls[0]?.[2].env).toMatchObject({ OVERRIDE: 'yes', PRIORITY: 'config' })
  vi.mocked(runProcess).mockClear()
  await harness.run({ prompt: 'task', cwd: tmpdir(), env: { PRIORITY: 'request' } }, () => {})
  expect(vi.mocked(runProcess).mock.calls[0]?.[0]).toBe('/custom/tool')
  expect(vi.mocked(runProcess).mock.calls[0]?.[2].env).toMatchObject({ OVERRIDE: 'yes', PRIORITY: 'request' })
})
it('覆盖优先级为运行请求 > 空间覆盖 > 工厂选项，且相对命令从空间解析', async () => {
  const c = config(); c.harnessOverrides = { codex: { command: './bin/codex', env: { SHARED: 'override' } } }
  const harness = createHarnesses({ config: c, projectDir: tmpdir(), codex: { bin: '/old', env: { ORIGINAL: 'kept', SHARED: 'factory' } } }).codex!
  await harness.run({ cwd: tmpdir(), prompt: 'x' }, () => {})
  expect(runProcess).toHaveBeenCalledWith(join(tmpdir(), 'bin/codex'), expect.any(Array), expect.objectContaining({ env: { ORIGINAL: 'kept', SHARED: 'override' } }), expect.anything())
})
it('disabled 从注册表移除，不进行探测且不能借停用覆盖保留 ID', () => {
  const c = config(); c.harnessOverrides = { codex: { disabled: true }, native: { disabled: true } }
  const harnesses = createHarnesses({ config: c })
  expect(harnesses.codex).toBeUndefined(); expect(harnesses.native).toBeUndefined(); expect(runProcess).not.toHaveBeenCalled()
  c.harnesses = [{ id: 'codex', kind: 'acp', command: ['agent'] }]
  expect(() => createHarnesses({ config: c })).toThrow('重复的 harness ID')
})
it('cli 与 acp 共存；预设与命令覆盖、原型键保持独立', () => {
  const c = config(); c.harnesses = [
    { id: 'custom-cli', kind: 'cli', command: ['./agent'], output: { format: 'text' } },
    { id: 'custom-acp', kind: 'acp', preset: 'gemini', command: ['./acp', '--custom'] },
    { id: '__proto__', kind: 'acp', command: ['other'] },
  ]
  const harnesses = createHarnesses({ config: c, projectDir: tmpdir() })
  expect(harnessCommand(harnesses['custom-cli']!)).toEqual([join(tmpdir(), 'agent')])
  expect(harnessCommand(harnesses['custom-acp']!)).toEqual([join(tmpdir(), 'acp'), '--custom'])
  expect(Object.getPrototypeOf(harnesses)).toBe(Object.prototype)
  expect(Object.hasOwn(harnesses, '__proto__')).toBe(true)
  c.harnesses.push({ id: 'custom-acp', kind: 'acp', command: ['other'] })
  expect(() => createHarnesses({ config: c })).toThrow('重复的 harness ID')
})
