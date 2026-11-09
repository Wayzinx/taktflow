import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest, ProviderConfig } from '@taktflow/core'
import { createProvider, PROVIDER_PRESETS, ProviderHttpError } from './index.js'
import { endpoint } from './http.js'
import { providerConfig } from './presets.js'

type Body = Record<string, any>
type Handler = (body: Body, req: IncomingMessage, res: ServerResponse, count: number) => void
const servers: Server[] = []
async function serve(handler: Handler): Promise<{ baseURL: string; bodies: Body[]; requests: IncomingMessage[] }> {
  const bodies: Body[] = []
  const requests: IncomingMessage[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Body : {}
    bodies.push(body)
    requests.push(req)
    handler(body, req, res, bodies.length)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, requests }
}
function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
function openai(content = 'hello', extra: Body = {}): Body {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], ...extra }
}
function anthropic(content = 'hello', extra: Body = {}): Body {
  return { content: [{ type: 'text', text: content }], stop_reason: 'end_turn', ...extra }
}
const request: ChatRequest = { model: 'unit-model', messages: [{ role: 'user', content: 'hi' }] }
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const tool = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
function local(baseURL: string, protocol: ProviderConfig['protocol'] = 'openai-chat', extra: Partial<ProviderConfig> = {}) {
  return createProvider('unit', { protocol, baseURL, ...extra }, { timeoutMs: 1000, retryDelayMs: 1, probeTimeoutMs: 100 })
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

describe('OpenAI chat', () => {
  it('maps messages, tools, schema, options and cached usage, then returns tool results', async () => {
    const api = await serve((_body, _req, res, count) => {
      if (count === 1) json(res, { choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } })
      else json(res, openai('{"ok":true}'))
    })
    const provider = local(`${api.baseURL}/v1/`)
    const first = await provider.chat({ ...request, messages: [{ role: 'system', content: 'system' }, ...request.messages], tools: [tool], responseSchema: schema, maxOutputTokens: 12, temperature: 0 })
    expect(first).toEqual({ message: { role: 'assistant', content: '', toolCalls: [{ id: 'call1', name: 'read_file', arguments: '{"path":"a"}' }] }, stopReason: 'tool_calls', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 } })
    expect(api.requests[0]?.url).toBe('/v1/chat/completions')
    expect(api.bodies[0]).toMatchObject({ model: 'unit-model', tools: [{ type: 'function', function: tool }], response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } }, max_tokens: 12, temperature: 0 })
    const second = await provider.chat({ ...request, messages: [...request.messages, first.message, { role: 'tool', toolCallId: 'call1', content: 'file text' }] })
    expect(api.bodies[1]?.messages[1].tool_calls[0].function.arguments).toBe('{"path":"a"}')
    expect(api.bodies[1]?.messages[2]).toEqual({ role: 'tool', content: 'file text', tool_call_id: 'call1' })
    expect(second.message.content).toBe('{"ok":true}')
    expect(second.usage).toBeUndefined()
  })

  it.each([400, 422])('downgrades only an unsupported schema feature (%i)', async status => {
    const api = await serve((_body, _req, res, count) => count === 1
      ? json(res, { error: { message: "response_format 'json_schema' is not supported with this model", param: 'response_format', code: 'unsupported_value' } }, status)
      : json(res, openai('{"ok":true}')))
    await local(api.baseURL).chat({ ...request, responseSchema: schema })
    expect(api.bodies).toHaveLength(2)
    expect(api.bodies[0]?.response_format).toBeDefined()
    expect(api.bodies[1]?.response_format).toBeUndefined()
    expect(api.bodies[1]?.messages.at(-1).content).toContain(JSON.stringify(schema))
    expect(request.messages).toHaveLength(1)
  })

  it.each([
    { message: 'Invalid schema: additionalProperties must be false', param: 'response_format', code: 'invalid_request_error' },
    { message: 'Invalid model' },
    { message: 'unsupported schema type integer', param: 'response_format', code: 'unsupported_value' },
    { message: 'temperature is not supported' },
  ])('does not downgrade ordinary invalid requests: $message', async error => {
    const api = await serve((_body, _req, res) => json(res, { error }, 400))
    await expect(local(api.baseURL).chat({ ...request, responseSchema: schema })).rejects.toMatchObject({ status: 400 })
    expect(api.bodies).toHaveLength(1)
  })

  it.each([['length', 'length'], ['content_filter', 'error'], ['stop', 'end'], ['unexpected', 'error']])('maps finish reason %s', async (reason, expected) => {
    const api = await serve((_body, _req, res) => json(res, { choices: [{ message: { role: 'assistant', content: 'part' }, finish_reason: reason }] }))
    expect((await local(api.baseURL).chat(request)).stopReason).toBe(expected)
  })
})

describe('Anthropic messages', () => {
  it('separates system, maps multiple tool roundtrips and sums cache input', async () => {
    const api = await serve((_body, _req, res, count) => {
      if (count === 1) json(res, { content: [{ type: 'text', text: 'reading' },
        { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a' } }, { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b' } }],
      stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 } })
      else json(res, anthropic('done'))
    })
    vi.stubEnv('TAKT_PROVIDER_TEST_KEY', 'fake-anthropic-key')
    const provider = local(api.baseURL, 'anthropic-messages', { apiKeyEnv: 'TAKT_PROVIDER_TEST_KEY' })
    const first = await provider.chat({ ...request, messages: [{ role: 'system', content: 's1' }, ...request.messages, { role: 'system', content: 's2' }], tools: [tool], maxOutputTokens: 99, temperature: 0.3 })
    expect(api.requests[0]?.url).toBe('/v1/messages')
    expect(api.requests[0]?.headers['x-api-key']).toBe('fake-anthropic-key')
    expect(api.requests[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(api.bodies[0]).toMatchObject({ system: 's1\n\ns2', max_tokens: 99, temperature: 0.3, tools: [{ name: 'read_file', input_schema: tool.parameters }] })
    expect(first).toMatchObject({ message: { content: 'reading', toolCalls: [{ id: 'a', name: 'read_file', arguments: '{"path":"a"}' }, { id: 'b', name: 'read_file', arguments: '{"path":"b"}' }] }, stopReason: 'tool_calls', usage: { inputTokens: 60, outputTokens: 5, cachedTokens: 30 } })
    await provider.chat({ ...request, messages: [...request.messages, first.message, { role: 'tool', toolCallId: 'a', content: 'A' }, { role: 'tool', toolCallId: 'b', content: 'B' }] })
    expect(api.bodies[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a' } }, { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'A' }, { type: 'tool_result', tool_use_id: 'b', content: 'B' }] },
    ])
  })

  it('forces a schema tool for final output and unwraps it as JSON', async () => {
    const api = await serve((body, _req, res) => json(res, { content: [{ type: 'tool_use', id: 'result', name: body.tool_choice.name, input: { result: { ok: true } } }], stop_reason: 'tool_use' }))
    const result = await local(`${api.baseURL}/v1/`, 'anthropic-messages').chat({ ...request, responseSchema: schema })
    expect(api.requests[0]?.url).toBe('/v1/messages')
    expect(api.bodies[0]?.tools[0].input_schema).toEqual({ type: 'object', properties: { result: schema }, required: ['result'], additionalProperties: false })
    expect(api.bodies[0]?.tool_choice.type).toBe('tool')
    expect(result).toEqual({ message: { role: 'assistant', content: '{"ok":true}' }, stopReason: 'end' })
  })

  it.each([
    { schema: { type: 'array', items: { type: 'integer' } }, value: [1, 2] },
    { schema: { type: 'string' }, value: 'scalar' },
    { schema: { type: 'number' }, value: 42 },
    { schema: { type: 'boolean' }, value: false },
    { schema: { type: 'null' }, value: null },
  ])('unwraps a root $schema.type as JSON text', async ({ schema, value }) => {
    const api = await serve((body, _req, res) => json(res, {
      content: [{ type: 'tool_use', id: 'r', name: body.tool_choice.name, input: { result: value } }], stop_reason: 'tool_use',
    }))
    const result = await local(api.baseURL, 'anthropic-messages').chat({ ...request, responseSchema: schema })
    expect(api.bodies[0]?.tools[0].input_schema.properties.result).toEqual(schema)
    expect(result.message.content).toBe(JSON.stringify(value))
    expect(result.stopReason).toBe('end')
    expect(result.message.toolCalls).toBeUndefined()
  })

  it('allows ordinary tools alongside schema and avoids reserved-name collisions', async () => {
    const api = await serve((_body, _req, res, count) => json(res, {
      content: [{ type: 'tool_use', id: `call${count}`, name: count === 1 ? 'takt_structured_result' : 'takt_structured_result_',
        input: count === 1 ? { path: 'a' } : { result: { ok: true } } }], stop_reason: 'tool_use',
    }))
    const provider = local(api.baseURL, 'anthropic-messages')
    const req = { ...request, responseSchema: schema, tools: [{ ...tool, name: 'takt_structured_result' }] }
    const first = await provider.chat(req)
    expect(api.bodies[0]?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    expect(api.bodies[0]?.tools.map((value: Body) => value.name)).toEqual(['takt_structured_result', 'takt_structured_result_'])
    expect(first.stopReason).toBe('tool_calls')
    expect(first.message.toolCalls).toEqual([{ id: 'call1', name: 'takt_structured_result', arguments: '{"path":"a"}' }])
    const final = await provider.chat({ ...req, messages: [...request.messages, first.message, { role: 'tool', toolCallId: 'call1', content: 'A' }] })
    expect(api.bodies[1]?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    expect(final).toEqual({ message: { role: 'assistant', content: '{"ok":true}' }, stopReason: 'end' })
  })

  it.each([
    { name: '$defs reference', schema: { $defs: { flag: { type: 'boolean' } }, type: 'object', properties: { ok: { $ref: '#/$defs/flag' } } } },
    { name: 'properties reference', schema: { type: 'object', properties: { ok: { type: 'boolean' }, other: { $ref: '#/properties/ok' } } } },
    { name: 'recursive root', schema: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#' } } } } },
    { name: 'schema ID', schema: { $id: 'https://schemas.example/result', type: 'object' } },
    { name: 'nested ID', schema: { type: 'object', properties: { child: { $id: 'child', type: 'object' } } } },
    { name: 'legacy ID', schema: { id: 'https://schemas.example/result', type: 'object' } },
    { name: 'dynamic reference', schema: { $dynamicAnchor: 'node', anyOf: [{ type: 'null' }, { $dynamicRef: '#node' }] } },
    { name: 'recursive reference', schema: { $recursiveAnchor: true, type: 'object', properties: { child: { $recursiveRef: '#' } } } },
  ])('uses the original schema in a prompt before sending a $name', async ({ schema }) => {
    const original = JSON.stringify(schema)
    const api = await serve((_body, _req, res) => json(res, anthropic('{"ok":true}')))
    const result = await local(api.baseURL, 'anthropic-messages').chat({ ...request, responseSchema: schema })
    expect(api.bodies).toHaveLength(1)
    expect(api.bodies[0]?.tools).toBeUndefined()
    expect(api.bodies[0]?.tool_choice).toBeUndefined()
    expect(api.bodies[0]?.system).toContain(original)
    expect(JSON.stringify(schema)).toBe(original)
    expect(result).toEqual({ message: { role: 'assistant', content: '{"ok":true}' }, stopReason: 'end' })
  })

  it('preserves ordinary tools when references require prompt fallback', async () => {
    const schema = { $defs: { result: { type: 'object' } }, $ref: '#/$defs/result' }
    const api = await serve((_body, _req, res) => json(res, {
      content: [{ type: 'tool_use', id: 'a', name: 'takt_structured_result', input: { path: 'a' } }], stop_reason: 'tool_use',
    }))
    const result = await local(api.baseURL, 'anthropic-messages').chat({ ...request, responseSchema: schema, tools: [{ ...tool, name: 'takt_structured_result' }] })
    expect(api.bodies[0]?.tools).toEqual([{ name: 'takt_structured_result', description: tool.description, input_schema: tool.parameters }])
    expect(api.bodies[0]?.tool_choice).toBeUndefined()
    expect(api.bodies[0]?.system).toContain(JSON.stringify(schema))
    expect(result.message.toolCalls).toEqual([{ id: 'a', name: 'takt_structured_result', arguments: '{"path":"a"}' }])
    expect(result.stopReason).toBe('tool_calls')
  })

  it('does not resend a prompt fallback on an unsupported-feature error', async () => {
    const api = await serve((_body, _req, res) => json(res, { error: { message: 'tool_choice is not supported' } }, 400))
    await expect(local(api.baseURL, 'anthropic-messages').chat({ ...request, responseSchema: { $ref: '#' } })).rejects.toMatchObject({ status: 400 })
    expect(api.bodies).toHaveLength(1)
  })

  it('falls back to a JSON prompt when forced tool choice is unsupported', async () => {
    const api = await serve((_body, _req, res, count) => count === 1
      ? json(res, { error: { message: 'tool_choice is not supported' } }, 400) : json(res, anthropic('{"ok":true}')))
    const result = await local(api.baseURL, 'anthropic-messages').chat({ ...request, responseSchema: schema })
    expect(api.bodies[1]?.tools).toBeUndefined()
    expect(api.bodies[1]?.tool_choice).toBeUndefined()
    expect(api.bodies[1]?.system).toContain(JSON.stringify(schema))
    expect(result.message.content).toBe('{"ok":true}')
  })

  it('does not mask an invalid tool schema as unsupported structured output', async () => {
    const api = await serve((_body, _req, res) => json(res, { error: { message: 'Invalid schema: required property is missing' } }, 400))
    await expect(local(api.baseURL, 'anthropic-messages').chat({ ...request, responseSchema: schema })).rejects.toMatchObject({ status: 400 })
    expect(api.bodies).toHaveLength(1)
  })

  it('rejects a structured tool response missing its result field', async () => {
    const api = await serve((body, _req, res) => json(res, {
      content: [{ type: 'tool_use', id: 'r', name: body.tool_choice.name, input: {} }], stop_reason: 'tool_use',
    }))
    await expect(local(api.baseURL, 'anthropic-messages').chat({ ...request, responseSchema: schema })).rejects.toThrow('invalid response structure')
  })

  it.each([['max_tokens', 'length'], ['refusal', 'error'], ['pause_turn', 'error'], ['stop_sequence', 'end']])('maps finish reason %s', async (reason, expected) => {
    const api = await serve((_body, _req, res) => json(res, anthropic('part', { stop_reason: reason })))
    expect((await local(api.baseURL, 'anthropic-messages').chat(request)).stopReason).toBe(expected)
  })

  it('rejects malformed outgoing tool arguments without exposing their contents', async () => {
    const api = await serve((_body, _req, res) => json(res, anthropic()))
    await expect(local(api.baseURL, 'anthropic-messages').chat({ ...request, messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'tool', arguments: 'secret-invalid-json' }] }] })).rejects.toThrow('tool arguments must be a JSON object')
    expect(api.bodies).toHaveLength(0)
  })
})

describe('shared transport', () => {
  it.each(['openai-chat', 'anthropic-messages'])('retries 429 and 5xx for %s', async protocol => {
    const api = await serve((_body, _req, res, count) => count < 4
      ? json(res, { error: { message: 'transient' } }, count === 1 ? 429 : 503)
      : json(res, protocol === 'openai-chat' ? openai() : anthropic()))
    expect((await local(api.baseURL, protocol).chat(request)).message.content).toBe('hello')
    expect(api.bodies).toHaveLength(4)
  })

  it.each([429, 500, 503])('caps retries at three and retains HTTP %i', async status => {
    const api = await serve((_body, _req, res) => json(res, { error: { message: 'fake-secret' } }, status))
    await expect(local(api.baseURL).chat(request)).rejects.toMatchObject({ status, message: `Provider request HTTP ${status}: request rejected` })
    expect(api.bodies).toHaveLength(4)
  })

  it.each([400, 401, 403, 404, 408, 422])('does not retry HTTP %i or expose echoed credentials', async status => {
    const api = await serve((_body, _req, res) => json(res, { error: { message: 'fake-secret response_format is not supported' } }, status))
    await expect(local(api.baseURL).chat(request)).rejects.toMatchObject({ status, message: `Provider request HTTP ${status}: request rejected` })
    expect(api.bodies).toHaveLength(1)
  })

  it('reads keys on each request and permits explicit header overrides', async () => {
    const api = await serve((_body, _req, res) => json(res, openai()))
    const provider = local(api.baseURL, 'openai-chat', { apiKeyEnv: 'TAKT_PROVIDER_TEST_KEY' })
    vi.stubEnv('TAKT_PROVIDER_TEST_KEY', 'fake-one')
    await provider.chat(request)
    vi.stubEnv('TAKT_PROVIDER_TEST_KEY', 'fake-two')
    await provider.chat(request)
    expect(api.requests.map(req => req.headers.authorization)).toEqual(['Bearer fake-one', 'Bearer fake-two'])
    await local(api.baseURL, 'openai-chat', { headers: { authorization: 'custom-value', 'x-test': 'header' } }).chat(request)
    expect(api.requests[2]?.headers.authorization).toBe('custom-value')
    expect(api.requests[2]?.headers['x-test']).toBe('header')
  })

  it('fails before network when the configured key is missing', async () => {
    const api = await serve((_body, _req, res) => json(res, openai()))
    vi.stubEnv('TAKT_PROVIDER_TEST_KEY', '')
    const provider = local(api.baseURL, 'openai-chat', { apiKeyEnv: 'TAKT_PROVIDER_TEST_KEY' })
    await expect(provider.chat(request)).rejects.toThrow('API key environment variable is missing')
    expect((await provider.available()).ok).toBe(false)
    expect(api.bodies).toHaveLength(0)
  })

  it.each(['openai-chat', 'anthropic-messages'])('custom auth headers cannot bypass a missing configured key (%s)', async protocol => {
    const api = await serve((_body, _req, res) => json(res, openai()))
    vi.stubEnv('TAKT_PROVIDER_TEST_KEY', '')
    const provider = local(api.baseURL, protocol, { apiKeyEnv: 'TAKT_PROVIDER_TEST_KEY',
      headers: { authorization: 'Bearer fake-header', 'x-api-key': 'fake-header' } })
    await expect(provider.chat(request)).rejects.toThrow('API key environment variable is missing')
    expect((await provider.available()).ok).toBe(false)
    expect(api.bodies).toHaveLength(0)
  })

  it('cancels before dispatch without reflecting caller abort reason', async () => {
    const api = await serve((_body, _req, res) => json(res, openai()))
    const controller = new AbortController()
    controller.abort(new Error('fake-secret'))
    await expect(local(api.baseURL).chat({ ...request, signal: controller.signal })).rejects.toThrow('cancelled')
    expect(api.bodies).toHaveLength(0)
  })

  it.each([200, 503])('cancels during body read (HTTP %i)', async status => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const api = await serve((_body, _req, res) => { res.writeHead(status); res.write('{'); started() })
    const controller = new AbortController()
    const pending = local(api.baseURL).chat({ ...request, signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ status, message: `Provider request HTTP ${status}: cancelled` })
    await ready
    // 等响应头进入 fetch，随后中断未结束的正文。
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort('fake-secret')
    await rejection
    expect(api.bodies).toHaveLength(1)
  })

  it('cancels during retry backoff', async () => {
    let replied!: () => void
    const ready = new Promise<void>(resolve => { replied = resolve })
    const api = await serve((_body, _req, res) => { json(res, {}, 429); replied() })
    const controller = new AbortController()
    const provider = createProvider('test', { protocol: 'openai-chat', baseURL: api.baseURL }, { timeoutMs: 2000, retryDelayMs: 1000 })
    const rejection = expect(provider.chat({ ...request, signal: controller.signal })).rejects.toThrow('cancelled')
    await ready
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    await rejection
    expect(api.bodies).toHaveLength(1)
  })

  it('cancels while waiting for response headers', async () => {
    let received!: () => void
    const ready = new Promise<void>(resolve => { received = resolve })
    const api = await serve(() => received())
    const controller = new AbortController()
    const rejection = expect(local(api.baseURL).chat({ ...request, signal: controller.signal })).rejects.toThrow('cancelled')
    await ready
    controller.abort()
    await rejection
    expect(api.bodies).toHaveLength(1)
  })

  it.each(['headers', 'body', 'retry'])('enforces a deadline during %s', async phase => {
    const api = await serve((_body, _req, res) => {
      if (phase === 'body') { res.writeHead(200); res.write('{') }
      if (phase === 'retry') json(res, {}, 503)
    })
    const provider = createProvider('test', { protocol: 'openai-chat', baseURL: api.baseURL }, { timeoutMs: 60, retryDelayMs: 1000 })
    const started = Date.now()
    await expect(provider.chat(request)).rejects.toThrow('timed out')
    expect(Date.now() - started).toBeLessThan(500)
    expect(api.bodies).toHaveLength(1)
  })

  it('shares retry budget across schema downgrade', async () => {
    const api = await serve((_body, _req, res, count) => {
      if (count === 3) json(res, { error: { message: 'json_schema is not supported' } }, 400)
      else json(res, {}, 503)
    })
    await expect(local(api.baseURL).chat({ ...request, responseSchema: schema })).rejects.toMatchObject({ status: 503 })
    expect(api.bodies).toHaveLength(5)
  })

  it('shares the deadline across schema downgrade', async () => {
    const api = await serve((_body, _req, res, count) => {
      if (count === 1) setTimeout(() => json(res, { error: { message: 'json_schema is not supported' } }, 400), 100)
    })
    const provider = createProvider('test', { protocol: 'openai-chat', baseURL: api.baseURL }, { timeoutMs: 180 })
    const started = Date.now()
    await expect(provider.chat({ ...request, responseSchema: schema })).rejects.toThrow('timed out')
    expect(Date.now() - started).toBeLessThan(250)
    expect(api.bodies).toHaveLength(2)
  })

  it.each([401, 403])('never downgrades schema on authentication HTTP %i', async status => {
    const api = await serve((_body, _req, res) => json(res, { error: { message: 'json_schema is not supported' } }, status))
    await expect(local(api.baseURL).chat({ ...request, responseSchema: schema })).rejects.toMatchObject({ status })
    expect(api.bodies).toHaveLength(1)
  })

  it('does not follow redirects carrying authentication', async () => {
    const api = await serve((_body, _req, res) => { res.writeHead(307, { location: '/other' }); res.end() })
    await expect(local(api.baseURL).chat(request)).rejects.toMatchObject({ status: 307 })
    expect(api.bodies).toHaveLength(1)
  })

  it('rejects invalid JSON and malformed response shape safely', async () => {
    const api = await serve((_body, _req, res, count) => count === 1 ? res.end('fake-secret') : json(res, { secret: 'fake-secret' }))
    await expect(local(api.baseURL).chat(request)).rejects.toThrow('invalid JSON response')
    await expect(local(api.baseURL).chat(request)).rejects.toThrow('invalid response structure')
  })

  it.each([200, 404, 405, 401, 403, 429, 500])('probes with HEAD, never generation (%i)', async status => {
    const api = await serve((_body, _req, res) => { res.writeHead(status); res.end() })
    const result = await local(api.baseURL).available()
    expect(api.requests[0]?.method).toBe('HEAD')
    expect(result.ok).toBe([200, 404, 405].includes(status))
    if (!result.ok) expect(result.reason).toContain(String(status))
  })

  it('bounds probe timeout and rejects missing baseURL', async () => {
    const api = await serve(() => {})
    expect((await local(api.baseURL).available()).ok).toBe(false)
    const missing = createProvider('custom', { protocol: 'openai-chat' })
    expect((await missing.available()).ok).toBe(false)
    await expect(missing.chat(request)).rejects.toThrow('baseURL is required')
  })
})

describe('configuration and resolution', () => {
  it('contains all fifteen presets and leaves deployment-specific addresses undefined', () => {
    expect(Object.keys(PROVIDER_PRESETS)).toEqual(['openai', 'anthropic', 'deepseek', 'moonshot', 'zhipu', 'dashscope', 'ark', 'minimax', 'siliconflow', 'openrouter', 'azure-openai', 'ollama', 'vllm', 'lmstudio', 'litellm'])
    expect(PROVIDER_PRESETS['azure-openai'].baseURL).toBeUndefined()
    expect(PROVIDER_PRESETS.vllm.baseURL).toBeUndefined()
    expect(PROVIDER_PRESETS.litellm.baseURL).toBeUndefined()
    expect(PROVIDER_PRESETS.deepseek.baseURL).toBe('https://api.deepseek.com')
    expect(PROVIDER_PRESETS.zhipu.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('merges presets and honors explicit endpoint, protocol, key and headers', async () => {
    const api = await serve((_body, _req, res) => json(res, openai()))
    vi.stubEnv('TAKT_PROVIDER_TEST_KEY', 'fake-key')
    const provider = createProvider('alias', { protocol: 'openai-chat', preset: 'anthropic', baseURL: `${api.baseURL}/api/v3`, apiKeyEnv: 'TAKT_PROVIDER_TEST_KEY', headers: { 'x-test': 'yes' } })
    await provider.chat(request)
    expect(provider.protocol).toBe('openai-chat')
    expect(api.requests[0]?.url).toBe('/api/v3/chat/completions')
    expect(api.requests[0]?.headers.authorization).toBe('Bearer fake-key')
    expect(api.requests[0]?.headers['x-test']).toBe('yes')
  })

  it.each(['azure-openai', 'azure-alias'])('uses env-only Azure api-key authentication for %s', async id => {
    const api = await serve((_body, _req, res) => json(res, openai()))
    const config = { protocol: 'openai-chat', baseURL: `${api.baseURL}/openai/deployments/test?api-version=2024-10-21`,
      ...(id === 'azure-alias' ? { preset: 'azure-openai' } : {}) }
    const normalized = providerConfig(id, config)
    expect(normalized.preset).toBe('azure-openai')
    expect(normalized.headers).toBeUndefined()
    const provider = createProvider('normalized-alias', normalized)
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'fake-azure-key')
    await provider.chat(request)
    expect(api.requests[0]?.headers['api-key']).toBe('fake-azure-key')
    expect(api.requests[0]?.headers.authorization).toBeUndefined()
    expect(api.requests[0]?.url).toBe('/openai/deployments/test/chat/completions?api-version=2024-10-21')
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'rotated-fake-azure-key')
    await provider.chat(request)
    expect(api.requests[1]?.headers['api-key']).toBe('rotated-fake-azure-key')
  })

  it.each([
    ['https://unit.test/v1/', 'openai-chat', '/v1/chat/completions'],
    ['https://unit.test/api/v3', 'openai-chat', '/api/v3/chat/completions'],
    ['https://unit.test', 'anthropic-messages', '/v1/messages'],
    ['https://unit.test/', 'anthropic-messages', '/v1/messages'],
    ['https://unit.test/v1', 'anthropic-messages', '/v1/messages'],
    ['https://unit.test/v1/', 'anthropic-messages', '/v1/messages'],
    ['https://unit.test/proxy', 'anthropic-messages', '/proxy/v1/messages'],
    ['https://unit.test/proxy/?api-version=2024', 'anthropic-messages', '/proxy/v1/messages'],
    ['https://unit.test/proxy/v1', 'anthropic-messages', '/proxy/v1/messages'],
    ['https://unit.test/proxy/v1/?api-version=2024', 'anthropic-messages', '/proxy/v1/messages'],
    ['https://unit.test/proxy/v1/messages/?api-version=2024', 'anthropic-messages', '/proxy/v1/messages'],
    ['https://unit.test/anthropic/v1', 'anthropic-messages', '/anthropic/v1/messages'],
    ['https://unit.test/v1/chat/completions?api-version=2024', 'openai-chat', '/v1/chat/completions'],
  ] as const)('normalizes %s (%s)', (baseURL, protocol, expected) => {
    const url = endpoint({ protocol, baseURL }, protocol)
    expect(url.pathname).toBe(expected)
    if (baseURL.includes('?')) expect(url.search).toBe('?api-version=2024')
  })

  it.each(['not-a-url', 'ftp://unit.test', 'https://user:fake-secret@unit.test', 'https://unit.test/#fake-secret'])('rejects unsafe URL without echo: %s', baseURL => {
    expect(() => endpoint({ protocol: 'openai-chat', baseURL }, 'openai-chat')).toThrow(/Invalid provider baseURL|without credentials or fragment/)
  })

  it('rejects unknown presets and unsupported protocols explicitly', () => {
    expect(() => createProvider('test', { protocol: 'openai-chat', preset: 'unknown' })).toThrow('Unknown provider preset')
    expect(() => createProvider('test', { protocol: 'openai-responses' })).toThrow('Unsupported provider protocol')
  })

  it('normalizes preset defaults without resolving model aliases', () => {
    expect(providerConfig('a', { protocol: 'openai-chat', preset: 'deepseek' })).toMatchObject({ baseURL: 'https://api.deepseek.com',
      endpoints: { 'anthropic-messages': 'https://api.deepseek.com/anthropic' } })
    expect(providerConfig('a', { protocol: 'openai-chat', preset: 'deepseek', endpoints: { 'anthropic-messages': 'https://proxy.invalid' } }).endpoints)
      .toEqual({ 'anthropic-messages': 'https://proxy.invalid' })
    expect(providerConfig('a', { protocol: 'openai-chat', preset: 'moonshot' })).not.toHaveProperty('endpoints')
    expect(providerConfig('ollama', { protocol: 'openai-chat' })).toMatchObject({ baseURL: 'http://localhost:11434/v1' })
  })
})
