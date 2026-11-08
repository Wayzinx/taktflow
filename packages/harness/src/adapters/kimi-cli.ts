import type { HarnessAdapter, Usage } from '@taktflow/core'
import { number, object, promptWithInstructions, string } from '../parse.js'
import type { EventSink, JsonObject, StreamParser } from '../parse.js'
import { createStreamCliHarness, StreamState } from './stream-cli.js'
import type { StreamCliOptions } from './stream-cli.js'

export interface KimiCliOptions extends StreamCliOptions {}

function messageUsage(value: unknown): Usage | undefined {
  const usage = object(value)
  const inputTokens = number(usage.prompt_tokens)
  const outputTokens = number(usage.completion_tokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cachedTokens = number(object(usage.prompt_tokens_details).cached_tokens)
  return { inputTokens, outputTokens, ...(cachedTokens === undefined ? {} : { cachedTokens }) }
}

export function createKimiCliParser(onEvent: EventSink = () => {}): StreamParser {
  const state = new StreamState('Kimi CLI', onEvent)
  let started = false
  let wire = false
  let firstTextInStep = true
  let stepUsage: Usage | undefined
  const start = (data: JsonObject) => {
    if (!started) { state.started(data.session_id, data.model); started = true }
  }
  const content = (value: unknown, append: boolean) => {
    const parts = typeof value === 'string' ? [value] : Array.isArray(value)
      ? value.flatMap(item => {
        const part = object(item)
        return part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
      }) : []
    if (parts.length) state.answer(parts.join(''), append)
    return parts.length > 0
  }
  return state.parser(data => {
    // 只解释完整 OpenAI message；不猜测 choices/delta 或未知 Wire 版本。
    if (data.role === 'assistant') {
      start(data)
      state.completed = false
      const hasText = content(data.content, false)
      const calls = Array.isArray(data.tool_calls) ? data.tool_calls : []
      for (const entry of calls) {
        const call = object(entry)
        const fn = object(call.function)
        state.tool(call.id, string(fn.name) ?? 'tool_call', fn.arguments)
      }
      state.usage(messageUsage(data.usage))
      // 完整的无工具 assistant message 是 message 格式的结束边界，Wire 必须等 TurnEnd。
      state.completed = !wire && hasText && calls.length === 0
        && (data.finish_reason === undefined || data.finish_reason === 'stop')
      return
    }
    if (data.role === 'tool') {
      state.completed = false
      state.toolResult(data.tool_call_id, data.content, data.is_error !== true, data)
      return
    }
    if (data.role === 'user' || data.role === 'system') {
      state.completed = false
      state.message(data.content, data.role)
      return
    }
    const payload = object(data.payload)
    switch (data.type) {
      case 'TurnBegin':
        wire = true
        state.completed = false
        state.value.finalText = ''
        firstTextInStep = true
        stepUsage = undefined
        start(payload)
        break
      case 'StepBegin':
        wire = true
        state.completed = false
        firstTextInStep = true
        stepUsage = undefined
        start(payload)
        break
      case 'ContentPart':
        wire = true
        start(payload)
        if (content([payload], !firstTextInStep)) firstTextInStep = false
        break
      case 'ToolCall': {
        wire = true
        state.completed = false
        start(payload)
        const fn = object(payload.function)
        state.tool(payload.id, string(fn.name) ?? 'tool_call', fn.arguments)
        break
      }
      case 'ToolResult': {
        wire = true
        state.completed = false
        const result = object(payload.return_value)
        state.toolResult(payload.tool_call_id, result.output, result.is_error !== true, data)
        break
      }
      case 'StatusUpdate': {
        const usage = object(payload.token_usage)
        const input = number(usage.input_other)
        const read = number(usage.input_cache_read)
        const write = number(usage.input_cache_creation)
        const output = number(usage.output)
        if (input !== undefined && read !== undefined && write !== undefined && output !== undefined) {
          const current = { inputTokens: input + read + write, outputTokens: output, cachedTokens: read }
          // 该 Wire 格式的 token_usage 是当前 step 的快照，不是全 run 累计。
          const delta = {
            inputTokens: current.inputTokens - (stepUsage?.inputTokens ?? 0),
            outputTokens: current.outputTokens - (stepUsage?.outputTokens ?? 0),
            cachedTokens: current.cachedTokens - (stepUsage?.cachedTokens ?? 0),
          }
          if (Object.values(delta).some(value => value < 0)) {
            state.fail('Unsupported Kimi token_usage: decreasing snapshot within one step')
            break
          }
          if (!stepUsage || Object.values(delta).some(value => value > 0)) state.usage(delta)
          stepUsage = current
        }
        break
      }
      case 'TurnEnd':
        // 单独一个 TurnEnd 不能把空流伪装成成功。
        state.completed = wire && started
        if (payload.error) state.fail(payload.error)
        break
      case 'StepInterrupted':
      case 'TurnInterrupted':
      case 'Error':
      case 'error': state.fail(data); break
      default: state.message(data)
    }
  }, state.result)
}

export function createKimiCliHarness(options: KimiCliOptions = {}): HarnessAdapter {
  return createStreamCliHarness({
    env: options.env,
    id: 'kimi-cli', displayName: 'Kimi CLI', bin: options.bin ?? 'kimi', parser: createKimiCliParser,
    command: req => ({ args: ['--print', '-p', promptWithInstructions(req), '--output-format=stream-json',
      ...(req.model ? ['--model', req.model] : [])] }),
  })
}
