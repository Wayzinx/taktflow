import type { ChatRequest, ChatResponse, ModelProvider, ProviderConfig, ToolCall, Usage } from '@taktflow/core'
import { endpoint, HttpOperation, invalidResponse, probe, ProviderHttpError, record, token } from './http.js'
import type { ProviderHttpOptions } from './http.js'
import { schemaPrompt } from './openai-chat.js'

type Block = Record<string, unknown>
type Message = { role: 'user' | 'assistant'; content: Block[] }

function resultToolName(req: ChatRequest): string {
  let name = 'takt_structured_result'
  while (req.tools?.some(tool => tool.name === name)) name += '_'
  return name
}

function hasSchemaReferences(schema: unknown): boolean {
  const pending = [schema]
  const seen = new Set<object>()
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    // 包装会移动 JSON Pointer 的根和 ID 的作用域；保守保留原 schema，以提示词传递。
    if (Object.keys(value).some(key => ['$ref', '$id', '$dynamicRef', '$recursiveRef', '$anchor', '$dynamicAnchor', '$recursiveAnchor'].includes(key))) return true
    if (typeof (value as Record<string, unknown>).id === 'string') return true
    pending.push(...Object.values(value))
  }
  return false
}

function payload(req: ChatRequest, nativeSchema: boolean): Record<string, unknown> {
  const system = req.messages.filter(message => message.role === 'system').map(message => message.content)
  const messages: Message[] = []
  for (const message of req.messages) {
    if (message.role === 'system') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content: Block[] = []
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new ProviderHttpError('tool result is missing toolCallId')
      content.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content })
    } else {
      if (message.content) content.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        let input: unknown
        try { input = JSON.parse(call.arguments) } catch { throw new ProviderHttpError('tool arguments must be a JSON object') }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderHttpError('tool arguments must be a JSON object')
        content.push({ type: 'tool_use', id: call.id, name: call.name, input })
      }
    }
    const previous = messages.at(-1)
    // 同一轮的多个工具结果必须作为同一个 user 消息，紧接 assistant 的 tool_use。
    if (previous?.role === role) previous.content.push(...content)
    else messages.push({ role, content })
  }
  const tools = (req.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
  if (req.responseSchema) {
    // 工具参数必须是对象；包装后仍可表达数组、标量和 null 的结果 schema。
    if (nativeSchema) tools.push({ name: resultToolName(req), description: 'Return the final structured result in the result field.', input_schema: {
      type: 'object', properties: { result: req.responseSchema }, required: ['result'], additionalProperties: false,
    } })
    else system.push(schemaPrompt(req.responseSchema))
  }
  return {
    model: req.model, messages, max_tokens: req.maxOutputTokens ?? 4096,
    ...(system.length ? { system: system.join('\n\n') } : {}),
    ...(tools.length ? { tools } : {}),
    ...(req.responseSchema && nativeSchema ? { tool_choice: req.tools?.length
      ? { type: 'auto', disable_parallel_tool_use: true }
      : { type: 'tool', name: resultToolName(req) } } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  }
}

function parse(value: unknown, resultName: string | undefined): ChatResponse {
  const body = record(value)
  if (!Array.isArray(body.content)) return invalidResponse()
  const text: string[] = []
  const calls: ToolCall[] = []
  let result: string | undefined
  for (const value of body.content) {
    const block = record(value)
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return invalidResponse()
      text.push(block.text)
    } else if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') return invalidResponse()
      const input = record(block.input)
      if (block.name === resultName) {
        if (result !== undefined || !Object.hasOwn(input, 'result')) return invalidResponse()
        result = JSON.stringify(input.result)
      } else calls.push({ id: block.id, name: block.name, arguments: JSON.stringify(input) })
    } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return invalidResponse()
  }
  if (result !== undefined && calls.length) return invalidResponse()
  let usage: Usage | undefined
  if (body.usage != null) {
    const raw = record(body.usage)
    const cached = raw.cache_read_input_tokens === undefined ? 0 : token(raw.cache_read_input_tokens)
    const created = raw.cache_creation_input_tokens === undefined ? 0 : token(raw.cache_creation_input_tokens)
    // Anthropic input_tokens 不含缓存；core 的 inputTokens 表示总输入，cachedTokens 是其中命中的部分。
    usage = { inputTokens: token(raw.input_tokens) + cached + created, outputTokens: token(raw.output_tokens),
      ...(raw.cache_read_input_tokens !== undefined ? { cachedTokens: cached } : {}) }
  }
  const reason = body.stop_reason
  return {
    message: { role: 'assistant', content: result ?? text.join(''), ...(calls.length ? { toolCalls: calls } : {}) },
    stopReason: reason === 'max_tokens' ? 'length'
      : reason === 'tool_use' ? (result !== undefined ? 'end' : calls.length ? 'tool_calls' : 'error')
      : reason === 'end_turn' || reason === 'stop_sequence' ? (calls.length ? 'tool_calls' : 'end') : 'error',
    ...(usage ? { usage } : {}),
  }
}

export function createAnthropicMessagesProvider(id: string, config: ProviderConfig, options: ProviderHttpOptions = {}): ModelProvider {
  return {
    id, protocol: 'anthropic-messages',
    available: () => probe(config, 'anthropic-messages', options),
    async chat(req) {
      const url = endpoint(config, 'anthropic-messages')
      const operation = new HttpOperation(req.signal, options)
      try {
        let value: unknown
        let nativeSchema = !hasSchemaReferences(req.responseSchema)
        try { value = await operation.post(url, config, 'anthropic-messages', payload(req, nativeSchema)) }
        catch (error) {
          if (!req.responseSchema || !nativeSchema || !(error instanceof ProviderHttpError) || !error.schemaUnsupported) throw error
          nativeSchema = false
          value = await operation.post(url, config, 'anthropic-messages', payload(req, false))
        }
        return parse(value, req.responseSchema && nativeSchema ? resultToolName(req) : undefined)
      } finally { operation.dispose() }
    },
  }
}
