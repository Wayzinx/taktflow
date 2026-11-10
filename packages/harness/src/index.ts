import { resolve } from 'node:path'
import { createAcpHarness } from './acp/index.js'
import { acpCommand } from './acp/presets.js'
import type { HarnessAdapter, ModelProvider, TaktConfig } from '@taktflow/core'
import { createGeminiCliHarness } from './adapters/gemini-cli.js'
import { createCursorAgentHarness } from './adapters/cursor-agent.js'
import { createQwenCodeHarness } from './adapters/qwen-code.js'
import { createKimiCliHarness } from './adapters/kimi-cli.js'
import { createOpenCodeHarness } from './adapters/opencode.js'
import { createPiHarness } from './adapters/pi.js'
import { createCliHarness } from './adapters/cli-generic.js'
import { createClaudeCodeHarness } from './claude-code.js'
import type { ClaudeCodeOptions } from './claude-code.js'
import { createCodexHarness, createTraeHarness } from './codex.js'
import type { CodexOptions } from './codex.js'
import { createDshHarness } from './dsh.js'
import type { DshOptions } from './dsh.js'
import { createNativeHarness } from './native/index.js'
import { createMockHarness } from './mock.js'
import type { MockScript } from './mock.js'

export { createGeminiCliHarness, createGeminiCliParser } from './adapters/gemini-cli.js'
export type { GeminiCliOptions } from './adapters/gemini-cli.js'
export { createCursorAgentHarness, createCursorAgentParser } from './adapters/cursor-agent.js'
export type { CursorAgentOptions } from './adapters/cursor-agent.js'
export { createQwenCodeHarness, createQwenCodeParser } from './adapters/qwen-code.js'
export type { QwenCodeOptions } from './adapters/qwen-code.js'
export { createKimiCliHarness, createKimiCliParser } from './adapters/kimi-cli.js'
export type { KimiCliOptions } from './adapters/kimi-cli.js'
export { createOpenCodeHarness, createOpenCodeParser } from './adapters/opencode.js'
export type { OpenCodeOptions } from './adapters/opencode.js'
export { createPiHarness, createPiParser } from './adapters/pi.js'
export type { PiOptions } from './adapters/pi.js'
export { createCliHarness, createCliParser, inferCliCapabilities } from './adapters/cli-generic.js'
export type { CliParserOptions } from './adapters/cli-generic.js'
export { createClaudeCodeHarness, createClaudeCodeParser } from './claude-code.js'
export type { ClaudeCodeOptions } from './claude-code.js'
export { createCodexHarness, createCodexParser, createTraeHarness } from './codex.js'
export type { CodexOptions } from './codex.js'
export { parseCodexModels, parseTraeModels } from './model-list.js'
export { harnessCatalogInfo } from './catalog-info.js'
export { createDshHarness, createDshParser } from './dsh.js'
export type { DshOptions } from './dsh.js'
export { createMockHarness, loadMockScript } from './mock.js'
export type { MockScript, MockStep } from './mock.js'
export { runProcess, extractJsonBlock, finalizeResult } from './process.js'
export type { ProcessOptions, ProcessResult } from './process.js'
export type { StreamParser } from './parse.js'
export * from './providers/index.js'
export { createNativeHarness } from './native/index.js'
export { providerConfig, withProviderPresets } from './providers/presets.js'
export { collectSecrets, createRedactor } from './redact.js'

export { createAcpHarness } from './acp/index.js'
export type { AcpOptions } from './acp/index.js'
export { ACP_PRESETS, acpCommand } from './acp/presets.js'

const commands = new WeakMap<HarnessAdapter, string[]>()
export function harnessCommand(harness: HarnessAdapter): string[] | undefined {
  const command = commands.get(harness)
  return command ? [...command] : undefined
}

export interface HarnessesOptions {
  /** 仅目录展示使用；不把停用项放回执行注册表。 */
  includeDisabled?: boolean
  config?: TaktConfig
  projectDir?: string
  /** native 使用已实例化的 provider（包括插件工厂）。 */
  providers?: Record<string, ModelProvider>
  geminiCli?: Parameters<typeof createGeminiCliHarness>[0]
  cursorAgent?: Parameters<typeof createCursorAgentHarness>[0]
  qwenCode?: Parameters<typeof createQwenCodeHarness>[0]
  kimiCli?: Parameters<typeof createKimiCliHarness>[0]
  openCode?: Parameters<typeof createOpenCodeHarness>[0]
  pi?: Parameters<typeof createPiHarness>[0]
  mockScript?: MockScript
  claudeCode?: ClaudeCodeOptions
  trae?: CodexOptions
  codex?: CodexOptions
  dsh?: DshOptions
}

export function createHarnesses(options: HarnessesOptions = {}): Record<string, HarnessAdapter> {
  const localCommand = (command: string) => command.includes('/') && !command.startsWith('/') ? resolve(options.projectDir ?? process.cwd(), command) : command
  const cliOptions = <T extends { bin?: string; env?: Record<string, string> }>(id: string, original: T | undefined): T => {
    const override = options.config?.harnessOverrides?.[id]
    return { ...original, ...(override?.command ? { bin: localCommand(override.command) } : {}),
      env: { ...original?.env, ...override?.env } } as T
  }
  const harnesses: Record<string, HarnessAdapter> = {
    native: createNativeHarness({ providers: options.providers ?? options.config?.providers ?? {}, models: options.config?.models ?? {} }),
    mock: createMockHarness(options.mockScript ?? { steps: [] }),
    'claude-code': createClaudeCodeHarness(cliOptions('claude-code', options.claudeCode)),
    codex: createCodexHarness(cliOptions('codex', options.codex)),
    trae: createTraeHarness(cliOptions('trae', options.trae)),
    dsh: createDshHarness(cliOptions('dsh', options.dsh)),
    'gemini-cli': createGeminiCliHarness(cliOptions('gemini-cli', options.geminiCli)),
    'cursor-agent': createCursorAgentHarness(cliOptions('cursor-agent', options.cursorAgent)),
    'qwen-code': createQwenCodeHarness(cliOptions('qwen-code', options.qwenCode)),
    'kimi-cli': createKimiCliHarness(cliOptions('kimi-cli', options.kimiCli)),
    'opencode': createOpenCodeHarness(cliOptions('opencode', options.openCode)),
    pi: createPiHarness(cliOptions('pi', options.pi)),
  }
  const builtins: Array<[string, string | undefined, string]> = [
    ['claude-code', options.claudeCode?.bin, 'claude'], ['codex', options.codex?.bin, 'codex'], ['trae', options.trae?.bin, 'traecli'],
    ['dsh', options.dsh?.bin, options.config?.harnessOverrides?.dsh?.env?.DSH_BIN ?? options.dsh?.env?.DSH_BIN ?? process.env.DSH_BIN ?? 'dsh'],
    ['gemini-cli', options.geminiCli?.bin, 'gemini'], ['cursor-agent', options.cursorAgent?.bin, 'cursor-agent'],
    ['qwen-code', options.qwenCode?.bin, 'qwen'], ['kimi-cli', options.kimiCli?.bin, 'kimi'],
    ['opencode', options.openCode?.bin, 'opencode'], ['pi', options.pi?.bin, 'pi'],
  ]
  for (const [id, bin, fallback] of builtins) {
    commands.set(harnesses[id]!, [localCommand(options.config?.harnessOverrides?.[id]?.command ?? bin ?? fallback)])
  }
  if (options.config?.harnessOverrides?.['claude-code']?.transport === 'acp') {
    const override = options.config.harnessOverrides['claude-code']!
    const command = acpCommand({ id: 'claude-code', kind: 'acp', preset: 'claude' })
    if (override.command) command[0] = localCommand(override.command)
    harnesses['claude-code'] = createAcpHarness({ id: 'claude-code', displayName: 'Claude Code', kind: 'acp', preset: 'claude',
      command, env: { ...options.claudeCode?.env, ...override.env } }, { projectDir: options.projectDir })
    commands.set(harnesses['claude-code'], command)
  }
  for (const config of options.config?.harnesses ?? []) {
    if (Object.hasOwn(harnesses, config.id)) throw new Error(`重复的 harness ID: ${config.id}`)
    const command = (config.kind === 'acp' ? acpCommand(config) : config.command).map((part, i) => i === 0 ? localCommand(part) : part)
    const adapter = config.kind === 'acp'
      ? createAcpHarness({ ...config, command }, { projectDir: options.projectDir })
      : createCliHarness(config, { projectDir: options.projectDir })
    commands.set(adapter, command)
    // defineProperty 避免社区 ID（如 __proto__）触发对象原型 setter。
    Object.defineProperty(harnesses, config.id, {
      value: adapter, enumerable: true, writable: true, configurable: true,
    })
  }
  // 删除后不会再被路由或探测；保留 ID 冲突检查，禁用不能借机覆盖内置实现。
  for (const [id, override] of Object.entries(options.config?.harnessOverrides ?? {})) {
    if (override.disabled && !options.includeDisabled) delete harnesses[id]
  }
  return harnesses
}
export { createProviderBridge } from './bridge/index.js'
