import type { HarnessAdapter } from '@taktflow/core'
import { createClaudeCodeParser } from '../claude-code.js'
import { promptWithInstructions } from '../parse.js'
import type { EventSink, StreamParser } from '../parse.js'
import { createStreamCliHarness } from './stream-cli.js'
import type { StreamCliOptions } from './stream-cli.js'

export interface CursorAgentOptions extends StreamCliOptions {}

export function createCursorAgentParser(onEvent: EventSink = () => {}): StreamParser {
  return createClaudeCodeParser(onEvent)
}

export function createCursorAgentHarness(options: CursorAgentOptions = {}): HarnessAdapter {
  return createStreamCliHarness({
    id: 'cursor-agent', displayName: 'Cursor Agent', bin: options.bin ?? 'cursor-agent',
    parser: createCursorAgentParser, capabilities: { cost: true },
    command: req => ({
      args: ['-p', '--output-format', 'stream-json', ...(req.model ? ['--model', req.model] : [])],
      stdin: promptWithInstructions(req),
    }),
  })
}
