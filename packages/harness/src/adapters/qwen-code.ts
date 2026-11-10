import { qwenProvider } from '../provider-injection.js'
import type { HarnessAdapter } from '@taktflow/core'
import { createClaudeCodeParser } from '../claude-code.js'
import { promptWithInstructions } from '../parse.js'
import type { EventSink, StreamParser } from '../parse.js'
import { createStreamCliHarness } from './stream-cli.js'
import type { StreamCliOptions } from './stream-cli.js'

export interface QwenCodeOptions extends StreamCliOptions {}

export function createQwenCodeParser(onEvent: EventSink = () => {}): StreamParser {
  // 仅支持 system/init、assistant/user content blocks、result 的兼容格式。
  return createClaudeCodeParser(onEvent)
}

export function createQwenCodeHarness(options: QwenCodeOptions = {}): HarnessAdapter {
  return createStreamCliHarness({
    env: options.env, provider: qwenProvider,
    id: 'qwen-code', displayName: 'Qwen Code', bin: options.bin ?? 'qwen',
    parser: createQwenCodeParser, capabilities: { cost: true },
    command: req => ({ args: ['-p', promptWithInstructions(req), '--output-format', 'stream-json',
      ...(!req.provider && req.model ? ['--model', req.model] : [])] }),
  })
}
