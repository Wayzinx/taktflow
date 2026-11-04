import type { HarnessAdapter } from '@taktflow/core'
import { createClaudeCodeHarness } from './claude-code.js'
import type { ClaudeCodeOptions } from './claude-code.js'
import { createCodexHarness } from './codex.js'
import type { CodexOptions } from './codex.js'
import { createDshHarness } from './dsh.js'
import type { DshOptions } from './dsh.js'
import { createMockHarness } from './mock.js'
import type { MockScript } from './mock.js'

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

export interface HarnessesOptions {
  mockScript?: MockScript
  claudeCode?: ClaudeCodeOptions
  codex?: CodexOptions
  dsh?: DshOptions
}

export function createHarnesses(options: HarnessesOptions = {}): Record<string, HarnessAdapter> {
  return {
    mock: createMockHarness(options.mockScript ?? { steps: [] }),
    'claude-code': createClaudeCodeHarness(options.claudeCode),
    codex: createCodexHarness(options.codex),
    dsh: createDshHarness(options.dsh),
  }
}
