import { randomUUID } from 'node:crypto'
import { encodeThinking, type StreamEvent, type Wire } from './wire.js'

export function downstream(anthropic: boolean, model: string, custom: Set<string>, send: (type: string, data: Wire) => void,
  namespaces: Map<string, { namespace: string; name: string }> = new Map()) {
  // 展平的命名空间工具还原成 Codex 认的 name + namespace
  const original = (name: string) => { const hit = namespaces.get(name); return hit ? { name: hit.name, namespace: hit.namespace } : { name } }
  const id = `msg_${randomUUID()}`, blocks: Wire[] = [], tools = new Map<number, number>()
  const stopped = new Set<number>()
  const usage = { input: 0, output: 0, cached: 0, reasoning: 0 }
  let active = -1, signature = '', reason = 'end_turn', sequence = 0
  const emit = (type: string, data: Wire) => send(type, { type, ...(!anthropic ? { sequence_number: sequence++ } : {}), ...data })
  const response = (status: string): Wire => ({ id, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status, output: blocks.map(item), usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: usage.cached }, output_tokens_details: { reasoning_tokens: usage.reasoning } }, ...(reason === 'max_tokens' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) })
  function item(b: Wire): Wire {
    if (b.type === 'text') return { type: 'message', id: b.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: b.text, annotations: [] }] }
    if (b.type === 'thinking') return { type: 'reasoning', id: b.id, summary: [{ type: 'summary_text', text: b.text }], encrypted_content: encodeThinking(b.text, signature) }
    if (custom.has(b.name)) {
      let input: unknown
      try { input = JSON.parse(b.arguments || '{}').input } catch { throw new Error('上游自由格式工具参数不是合法 JSON') }
      if (typeof input !== 'string') throw new Error('上游自由格式工具缺少 input 字符串')
      return { type: 'custom_tool_call', id: b.id, call_id: b.call_id, name: b.name, input, status: 'completed' }
    }
    return { type: 'function_call', id: b.id, call_id: b.call_id, ...original(b.name), arguments: b.arguments, status: 'completed' }
  }
  const closeActive = () => {
    if (active < 0 || !anthropic) return
    const b = blocks[active]!
    if (b.type === 'tool') { active = -1; return }
    if (b.type === 'thinking') emit('content_block_delta', { index: active, delta: { type: 'signature_delta', signature: encodeThinking(b.text, signature) } })
    emit('content_block_stop', { index: active }); stopped.add(active); active = -1
  }
  function start(b: Wire): number {
    closeActive()
    const index = blocks.length
    b.id ??= `item_${randomUUID()}`; blocks.push(b); active = index
    if (anthropic) emit('content_block_start', { index, content_block: b.type === 'text' ? { type: 'text', text: '' } : b.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'tool_use', id: b.call_id, name: b.name, input: {} } })
    else emit('response.output_item.added', { output_index: index, item: b.type === 'text' ? { type: 'message', id: b.id, role: 'assistant', status: 'in_progress', content: [] } : b.type === 'thinking' ? { type: 'reasoning', id: b.id, summary: [] } : { type: custom.has(b.name) ? 'custom_tool_call' : 'function_call', id: b.id, call_id: b.call_id, ...original(b.name), ...(custom.has(b.name) ? { input: '' } : { arguments: '' }), status: 'in_progress' } })
    return index
  }
  return {
    start() {
      if (anthropic) emit('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
      else { emit('response.created', { response: response('in_progress') }); emit('response.in_progress', { response: response('in_progress') }) }
    },
    event(event: StreamEvent) {
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'usage') { for (const key of ['input', 'output', 'cached', 'reasoning'] as const) if (event[key] !== undefined) usage[key] = event[key]; return }
      if (event.type === 'finish') { reason = event.reason; return }
      if (event.type === 'signature') { signature += event.text; return }
      if (event.type === 'tool') { tools.set(event.index, start({ type: 'tool', call_id: event.id, name: event.name, arguments: '' })); return }
      if (event.type === 'arguments') {
        const index = tools.get(event.index)
        if (index === undefined) throw new Error('上游工具参数没有对应调用')
        const b = blocks[index]!; b.arguments += event.text
        if (anthropic) emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: event.text } })
        else if (!custom.has(b.name)) emit('response.function_call_arguments.delta', { item_id: b.id, output_index: index, delta: event.text })
        return
      }
      if (active < 0 || blocks[active]!.type !== event.type) start({ type: event.type, text: '' })
      const b = blocks[active]!; b.text += event.text
      if (anthropic) emit('content_block_delta', { index: active, delta: event.type === 'text' ? { type: 'text_delta', text: event.text } : { type: 'thinking_delta', thinking: event.text } })
      else emit(event.type === 'text' ? 'response.output_text.delta' : 'response.reasoning_summary_text.delta', { item_id: b.id, output_index: active, content_index: 0, summary_index: 0, delta: event.text })
    },
    finish(): Wire {
      closeActive()
      if (anthropic) {
        blocks.forEach((_, index) => { if (!stopped.has(index)) emit('content_block_stop', { index }) })
        const value = { id, type: 'message', role: 'assistant', model, content: blocks.map(b => b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'thinking' ? { type: 'thinking', thinking: b.text, signature: encodeThinking(b.text, signature) } : { type: 'tool_use', id: b.call_id, name: b.name, input: JSON.parse(b.arguments || '{}') }), stop_reason: reason, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output } }
        emit('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: value.usage }); emit('message_stop', {})
        return value
      }
      blocks.forEach((b, i) => emit('response.output_item.done', { output_index: i, item: item(b) }))
      const value = response('completed'); emit('response.completed', { response: value }); return value
    },
  }
}
