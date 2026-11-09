import type { StreamEvent, Wire } from './wire.js'

async function* frames(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('上游没有响应流')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (data) yield data
      }
      if (done) break
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function* readEvents(response: Response, anthropic: boolean): AsyncGenerator<StreamEvent> {
  let terminal = false, reason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
  const tools = new Map<number, { id: string; name: string; started: boolean; arguments: string }>()
  for await (const data of frames(response)) {
    if (data === '[DONE]') { terminal = true; break }
    const v: Wire = JSON.parse(data)
    if (v.error || v.type === 'error') throw new Error(`上游流返回错误：${upstreamMessage(v) ?? '未知错误'}`)
    if (anthropic) {
      if (v.type === 'message_start') {
        const u = v.message.usage ?? {}
        yield { type: 'usage', input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0 }
      }
      if (v.type === 'content_block_start') {
        const b = v.content_block
        if (b.type === 'tool_use') {
          yield { type: 'tool', index: v.index, id: b.id, name: b.name }
          if (b.input && Object.keys(b.input).length) yield { type: 'arguments', index: v.index, text: JSON.stringify(b.input) }
        } else if (b.type === 'text' && b.text) yield { type: 'text', text: b.text }
        else if (b.type === 'thinking' && b.thinking) yield { type: 'thinking', text: b.thinking }
      }
      if (v.type === 'content_block_delta') {
        const d = v.delta
        if (d.type === 'text_delta') yield { type: 'text', text: d.text }
        if (d.type === 'thinking_delta') yield { type: 'thinking', text: d.thinking }
        if (d.type === 'signature_delta') yield { type: 'signature', text: d.signature }
        if (d.type === 'input_json_delta') yield { type: 'arguments', index: v.index, text: d.partial_json }
      }
      if (v.type === 'message_delta') {
        if (v.delta?.stop_reason) reason = v.delta.stop_reason === 'tool_use' ? 'tool_use' : v.delta.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn'
        if (v.usage) yield { type: 'usage', output: v.usage.output_tokens }
      }
      if (v.type === 'message_stop') { terminal = true; break }
    } else {
      const choice = v.choices?.[0], d = choice?.delta
      if (d?.content) yield { type: 'text', text: d.content }
      if (d?.reasoning_content) yield { type: 'thinking', text: d.reasoning_content }
      for (const t of d?.tool_calls ?? []) {
        const call = tools.get(t.index) ?? { id: '', name: '', started: false, arguments: '' }
        if (t.id) call.id += t.id
        if (t.function?.name) call.name += t.function.name
        // 首个参数之前累积名称；避免把拆成多帧的工具名截断。
        if (t.function?.arguments) call.arguments += t.function.arguments
        if (!call.started && call.id && call.name && t.function?.arguments) {
          yield { type: 'tool', index: t.index, id: call.id, name: call.name }; call.started = true
          yield { type: 'arguments', index: t.index, text: call.arguments }; call.arguments = ''
        } else if (call.started && t.function?.arguments) { yield { type: 'arguments', index: t.index, text: call.arguments }; call.arguments = '' }
        tools.set(t.index, call)
      }
      if (choice?.finish_reason) reason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
      if (v.usage) yield { type: 'usage', input: v.usage.prompt_tokens ?? 0, output: v.usage.completion_tokens ?? 0, cached: v.usage.prompt_tokens_details?.cached_tokens ?? 0, reasoning: v.usage.completion_tokens_details?.reasoning_tokens ?? 0 }
    }
  }
  if (!terminal) throw new Error('上游响应流中断，缺少结束事件')
  for (const [index, t] of tools) if (!t.started) {
    if (!t.id || !t.name) throw new Error('上游工具调用不完整')
    yield { type: 'tool', index, id: t.id, name: t.name }
    if (t.arguments) yield { type: 'arguments', index, text: t.arguments }
  }
  yield { type: 'finish', reason }
}

/** 厂商错误体里给人看的那句（OpenAI / Anthropic / 各家兼容接口的常见形态）。 */
export function upstreamMessage(value: unknown): string | undefined {
  const v = value as Wire | undefined
  const message = v?.error?.message ?? v?.message ?? (typeof v?.error === 'string' ? v.error : undefined) ?? v?.detail
  return typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : undefined
}

export async function* upstreamEvents(response: Response, anthropic: boolean): AsyncGenerator<StreamEvent> {
  try { yield* readEvents(response, anthropic) }
  catch (error) { yield { type: 'error', message: error instanceof Error && error.message.startsWith('上游') ? error.message : '上游请求失败或响应流中断' } }
}
