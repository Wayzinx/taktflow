import type { HarnessAdapter, ModelProvider, TaktConfig } from '@taktflow/core'
import { createGeminiCliHarness } from './adapters/gemini-cli.js'
import { createCursorAgentHarness } from './adapters/cursor-agent.js'
import { createQwenCodeHarness } from './adapters/qwen-code.js'
import { createKimiCliHarness } from './adapters/kimi-cli.js'
import { createOpenCodeHarness } from './adapters/opencode.js'
import { createCliHarness } from './adapters/cli-generic.js'
import { createClaudeCodeHarness } from './claude-code.js'
import type { ClaudeCodeOptions } from './claude-code.js'
import { createCodexHarness } from './codex.js'
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
export { createCliHarness, createCliParser, inferCliCapabilities } from './adapters/cli-generic.js'
export type { CliParserOptions } from './adapters/cli-generic.js'
export { createClaudeCodeHarness, createClaudeCodeParser } from './claude-code.js'
export type { ClaudeCodeOptions } from './claude-code.js'
export { createCodexHarness, createCodexParser } from './codex.js'
export type { CodexOptions } from './codex.js'
export { createDshHarness, createDshParser } from './dsh.js'
export type { DshOptions } from './dsh.js'
export { createMockHarness, loadMockScript } from './mock.js'
export type { MockScript, MockStep } from './mock.js'
export { runProcess, extractJsonBlock, finalizeResult } from './process.js'
export type { ProcessOptions, ProcessResult } from './process.js'
export type { StreamParser } from './parse.js'
export * from './providers/index.js'
export { createNativeHarness } from './native/index.js'
export { providerConfig } from './providers/presets.js'
export { collectSecrets, createRedactor } from './redact.js'

export interface HarnessesOptions {
  config?: TaktConfig
  projectDir?: string
  /** native 使用已实例化的 provider（包括插件工厂）。 */
  providers?: Record<string, ModelProvider>
  geminiCli?: Parameters<typeof createGeminiCliHarness>[0]
  cursorAgent?: Parameters<typeof createCursorAgentHarness>[0]
  qwenCode?: Parameters<typeof createQwenCodeHarness>[0]
  kimiCli?: Parameters<typeof createKimiCliHarness>[0]
  openCode?: Parameters<typeof createOpenCodeHarness>[0]
  mockScript?: MockScript
  claudeCode?: ClaudeCodeOptions
  codex?: CodexOptions
  dsh?: DshOptions
}

export function createHarnesses(options: HarnessesOptions = {}): Record<string, HarnessAdapter> {
  const harnesses: Record<string, HarnessAdapter> = {
    native: createNativeHarness({ providers: options.providers ?? options.config?.providers ?? {}, models: options.config?.models ?? {} }),
    mock: createMockHarness(options.mockScript ?? { steps: [] }),
    'claude-code': createClaudeCodeHarness(options.claudeCode),
    codex: createCodexHarness(options.codex),
    dsh: createDshHarness(options.dsh),
    'gemini-cli': createGeminiCliHarness(options.geminiCli),
    'cursor-agent': createCursorAgentHarness(options.cursorAgent),
    'qwen-code': createQwenCodeHarness(options.qwenCode),
    'kimi-cli': createKimiCliHarness(options.kimiCli),
    'opencode': createOpenCodeHarness(options.openCode),
  }
  for (const config of options.config?.harnesses ?? []) {
    if (Object.hasOwn(harnesses, config.id)) throw new Error(`重复的 harness ID: ${config.id}`)
    // defineProperty 避免社区 ID（如 __proto__）触发对象原型 setter。
    Object.defineProperty(harnesses, config.id, {
      value: createCliHarness(config, { projectDir: options.projectDir }), enumerable: true, writable: true, configurable: true,
    })
  }
  return harnesses
}
