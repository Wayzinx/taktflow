import type { HarnessAdapter } from '@taktflow/core'
import { number, object, promptWithInstructions, string } from '../parse.js'
import type { EventSink, StreamParser } from '../parse.js'
import { createStreamCliHarness, StreamState } from './stream-cli.js'
import type { StreamCliOptions } from './stream-cli.js'

export interface GeminiCliOptions extends StreamCliOptions {}

export function createGeminiCliParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new StreamState('Gemini CLI', onEvent)
  return state.parser(data => {
    switch (data.type) {
      case 'init':
        state.completed = false
        state.started(data.session_id, data.model)
        break
      case 'message':
        if (data.role === 'assistant' && typeof data.content === 'string') state.answer(data.content, data.delta === true)
        else state.message(data.content ?? data, data.role === 'user' ? 'user' : 'system')
        break
      case 'tool_use':
        state.completed = false
        state.tool(data.tool_id, string(data.tool_name) ?? 'tool_use', data.parameters)
        break
      case 'tool_result':
        state.toolResult(data.tool_id, data.output, data.status === 'success', data)
        break
      case 'result': {
        const stats = object(data.stats)
        const inputTokens = number(stats.input_tokens)
        const outputTokens = number(stats.output_tokens)
        if (inputTokens !== undefined && outputTokens !== undefined) {
          const cachedTokens = number(stats.cached)
          state.usage({ inputTokens, outputTokens, ...(cachedTokens === undefined ? {} : { cachedTokens }) }, true)
        }
        state.completed = data.status === 'success'
        if (data.status === 'error' || data.error) state.fail(data)
        break
      }
      case 'error': state.fail(data); break
      default: state.message(data)
    }
  }, state.result)
}

export function createGeminiCliHarness(options: GeminiCliOptions = {}): HarnessAdapter {
  return createStreamCliHarness({
    id: 'gemini-cli', displayName: 'Gemini CLI', bin: options.bin ?? 'gemini', parser: createGeminiCliParser,
    command: req => ({ args: ['-p', promptWithInstructions(req), '--output-format', 'stream-json', '--yolo',
      ...(req.model ? ['--model', req.model] : [])] }),
  })
}
