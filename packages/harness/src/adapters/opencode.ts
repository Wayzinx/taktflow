import { openCodeProvider } from '../provider-injection.js'
import type { HarnessAdapter } from '@taktflow/core'
import { number, object, promptWithInstructions, string } from '../parse.js'
import type { EventSink, StreamParser } from '../parse.js'
import { createStreamCliHarness, StreamState } from './stream-cli.js'
import type { StreamCliOptions } from './stream-cli.js'

export interface OpenCodeOptions extends StreamCliOptions {}

export function createOpenCodeParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new StreamState('OpenCode', onEvent)
  const finishedSteps = new Set<string>()
  let started = false
  let firstTextInStep = true
  return state.parser(data => {
    const part = object(data.part)
    switch (data.type) {
      case 'step_start':
        state.completed = false
        firstTextInStep = true
        if (!started) { state.started(data.sessionID); started = true }
        break
      case 'text':
        if (typeof part.text === 'string') {
          state.answer(part.text, !firstTextInStep)
          firstTextInStep = false
        } else state.message(data)
        break
      case 'tool_use': {
        state.completed = false
        const tool = object(part.state)
        const name = string(part.tool) ?? 'tool_use'
        // CLI 的完成快照不能证明工具何时开始。
        if (tool.status === 'completed' || tool.status === 'error') {
          onEvent({ type: 'tool_call', tool: name, input: JSON.stringify(tool.input) ?? '', output: String(tool.output ?? tool.error ?? ''), ok: tool.status === 'completed' })
        }
        break
      }
      case 'step_finish': {
        const id = string(part.id)
        if (id && finishedSteps.has(id)) break
        if (id) finishedSteps.add(id)
        const tokens = object(part.tokens)
        const inputTokens = number(tokens.input)
        const outputTokens = number(tokens.output)
        if (inputTokens !== undefined && outputTokens !== undefined) {
          const cachedTokens = number(object(tokens.cache).read)
          const costUsd = number(part.cost)
          state.usage({ inputTokens, outputTokens,
            ...(cachedTokens === undefined ? {} : { cachedTokens }),
            ...(costUsd === undefined ? {} : { costUsd }),
          })
        }
        // tool-calls 只完成一次模型步骤；还不能当作整个任务成功。
        state.completed = part.reason === 'stop'
        if (part.reason === 'error') state.fail(data)
        break
      }
      case 'error': state.fail(data); break
      default: state.message(data)
    }
  }, state.result)
}

export function createOpenCodeHarness(options: OpenCodeOptions = {}): HarnessAdapter {
  return createStreamCliHarness({
    env: options.env, provider: openCodeProvider,
    id: 'opencode', displayName: 'OpenCode', bin: options.bin ?? 'opencode',
    parser: createOpenCodeParser, capabilities: { cost: true, toolPhases: false },
    command: req => ({ args: ['run', '--format', 'json', promptWithInstructions(req),
      ...(!req.provider && req.model ? ['--model', req.model] : [])] }),
  })
}
