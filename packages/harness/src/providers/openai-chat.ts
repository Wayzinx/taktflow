import type { ChatRequest, ChatResponse, ModelProvider, ProviderConfig, ToolCall, Usage } from '@taktflow/core'
import { endpoint, HttpOperation, invalidResponse, probe, ProviderHttpError, record, token } from './http.js'
import type { ProviderHttpOptions } from './http.js'

export function schemaPrompt(schema: Record<string, unknown>): string {
  return `Return only valid JSON matching this JSON Schema, without markdown or explanations:\n${JSON.stringify(schema)}`
}

function payload(req: ChatRequest, nativeSchema: boolean): Record<string, unknown> {
  const messages = req.messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
    })) } : {}),
  }))
  if (req.responseSchema && !nativeSchema) messages.push({ role: 'system', content: schemaPrompt(req.responseSchema) })
  return {
    model: req.model, messages,
    ...(req.tools?.length ? { tools: req.tools.map(tool => ({ type: 'function', function: tool })) } : {}),
    ...(req.responseSchema && nativeSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: req.responseSchema } } } : {}),
    ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  }
}

function parse(value: unknown): ChatResponse {
  const body = record(value)
  if (!Array.isArray(body.choices) || !body.choices.length) return invalidResponse()
  const choice = record(body.choices[0])
  const message = record(choice.message)
  if (message.role !== 'assistant' || message.content != null && typeof message.content !== 'string') return invalidResponse()
  let calls: ToolCall[] | undefined
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) return invalidResponse()
    calls = message.tool_calls.map(value => {
      const call = record(value)
      const fn = record(call.function)
      if (typeof call.id !== 'string' || call.type !== 'function' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') return invalidResponse()
      return { id: call.id, name: fn.name, arguments: fn.arguments }
    })
  }
  let usage: Usage | undefined
  if (body.usage != null) {
    const raw = record(body.usage)
    const details = raw.prompt_tokens_details == null ? undefined : record(raw.prompt_tokens_details)
    usage = { inputTokens: token(raw.prompt_tokens), outputTokens: token(raw.completion_tokens),
      ...(details?.cached_tokens !== undefined ? { cachedTokens: token(details.cached_tokens) } : {}) }
  }
  const reason = choice.finish_reason
  return {
    message: { role: 'assistant', content: message.content as string | undefined ?? '', ...(calls?.length ? { toolCalls: calls } : {}) },
    stopReason: reason === 'length' ? 'length' : reason === 'tool_calls' && calls?.length ? 'tool_calls'
      : reason === 'stop' ? (calls?.length ? 'tool_calls' : 'end') : 'error',
    ...(usage ? { usage } : {}),
  }
}

export function createOpenAIChatProvider(id: string, config: ProviderConfig, options: ProviderHttpOptions = {}): ModelProvider {
  return {
    id, protocol: 'openai-chat',
    available: () => probe(config, 'openai-chat', options),
    async chat(req) {
      const url = endpoint(config, 'openai-chat')
      const operation = new HttpOperation(req.signal, options)
      try {
        let value: unknown
        try { value = await operation.post(url, config, 'openai-chat', payload(req, true)) }
        catch (error) {
          if (!req.responseSchema || !(error instanceof ProviderHttpError) || !error.schemaUnsupported) throw error
          value = await operation.post(url, config, 'openai-chat', payload(req, false))
        }
        return parse(value)
      } finally { operation.dispose() }
    },
  }
}
