import { beforeEach, expect, it, vi } from 'vitest'
import { createClaudeCodeHarness } from './claude-code.js'
import { createCodexHarness, createTraeHarness } from './codex.js'
import { execFile } from 'node:child_process'
import { parseCodexModels, parseTraeModels } from './model-list.js'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: vi.fn() }))
type Callback = (error: Error | null, stdout: string, stderr: string) => void
/** 让 execFile 按给定结果回调；error 为空即退出码 0。 */
const reply = (stdout: string, error?: Error, stderr = '') => vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
  const callback = args.findLast((arg): arg is Callback => typeof arg === 'function')
  callback?.(error ?? null, stdout, stderr)
  return {} as ReturnType<typeof execFile>
}) as unknown as typeof execFile)

// 2026-11-10 本机 debug models 的公开模型片段，省去描述和指令模板。
const codex = { models: [{ slug: 'gpt-5.2', display_name: 'GPT-5.2', context_window: 272000,
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
  default_reasoning_level: 'medium', visibility: 'list' }] }
beforeEach(() => vi.mocked(execFile).mockReset())

it('Codex 录制片段解析名称、窗口和推理档', async () => {
  reply(JSON.stringify(codex))
  expect(await createCodexHarness({ bin: '/custom/codex' }).listModels!()).toEqual([{
    id: 'gpt-5.2', label: 'GPT-5.2', contextWindow: 272000, reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', origin: 'harness',
  }])
  expect(execFile).toHaveBeenCalledWith('/custom/codex', ['debug', 'models'], expect.objectContaining({ timeout: 20_000 }), expect.any(Function))
})

it('Codex visibility 过滤；none/minimal/未知档丢弃，max 保留', () => {
  const sample = codex.models[0]!
  const parsed = parseCodexModels(JSON.stringify({ models: [
    { ...sample, visibility: 'hide' }, { ...sample, visibility: undefined },
    { ...sample, default_reasoning_level: 'none', supported_reasoning_levels: ['none', 'minimal', 'max', 'max', 'unknown'].map(effort => ({ effort })) },
  ] }))
  expect(parsed).toEqual([expect.objectContaining({ efforts: ['max'] })])
  expect(parsed[0]).not.toHaveProperty('defaultEffort')
  expect(() => parseCodexModels('{}')).toThrow('models')
  expect(() => parseCodexModels('{')).toThrow()
})

it('TRAE 逐行公开模型样本保留原 ID，拒绝无法可靠解析的文本', async () => {
  const output = 'DeepSeek-V4-Pro\nGPT-5.2\n'
  reply(output)
  expect(await createTraeHarness().listModels!()).toEqual([
    { id: 'DeepSeek-V4-Pro', label: 'DeepSeek-V4-Pro', origin: 'harness' },
    { id: 'GPT-5.2', label: 'GPT-5.2', origin: 'harness' },
  ])
  expect(execFile).toHaveBeenCalledWith('traecli', ['models'], expect.anything(), expect.any(Function))
  expect(() => parseTraeModels('Please sign in')).toThrow('格式')
  expect(() => parseTraeModels('')).toThrow('格式')
})

it.each([true, false])('Claude 固定别名，按 help 是否存在 effort=%s 决定推理档', async enabled => {
  // 真实 help 里有「default model is overloaded」，退出码 0 就是成功，不能按关键词判失败
  reply(`${enabled ? '  --effort <level>  Effort level for the current session\n' : '--model <model>\n'}  --fallback-model <model>  Enable automatic fallback when default model is overloaded\n`)
  const models = await createClaudeCodeHarness().listModels!()
  expect(models.map(m => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
  expect(models[0]).toMatchObject({ label: 'Opus（订阅默认最新）' })
  expect(models[0]!.efforts).toEqual(enabled ? ['low', 'medium', 'high', 'xhigh', 'max'] : undefined)
  expect(models[0]!.defaultEffort).toBe(enabled ? 'high' : undefined)
})

it('CLI 列表失败不会当作成功的空列表，错误带 stderr 末行', async () => {
  reply('', new Error('Command failed'), 'warn\nError: not logged in\n')
  await expect(createCodexHarness().listModels!()).rejects.toThrow('列出自带模型失败：warn Error: not logged in')
})
