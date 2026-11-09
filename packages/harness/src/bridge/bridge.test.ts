import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProviderBridge } from './index.js'
import { claudeRequest, codexRequest, traeRequest } from './fixtures.js'
import type { Wire } from './wire.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
const data = (res: ServerResponse, v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`)
function reply(res: ServerResponse, anthropic: boolean, tool = false, missingEnd = false, usage = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (anthropic) {
    data(res, { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 2 } } })
    data(res, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    data(res, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } })
    data(res, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'upstream-signature' } })
    data(res, { type: 'content_block_stop', index: 0 })
    data(res, { type: 'content_block_start', index: 1, content_block: tool ? { type: 'tool_use', id: 'call-1', name: 'Read', input: {} } : { type: 'text', text: '' } })
    data(res, { type: 'content_block_delta', index: 1, delta: tool ? { type: 'input_json_delta', partial_json: '{"path":"a"}' } : { type: 'text_delta', text: 'OK' } })
    data(res, { type: 'content_block_stop', index: 1 })
    data(res, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 4 } })
    if (!missingEnd) data(res, { type: 'message_stop' })
  } else {
    data(res, { choices: [{ delta: { reasoning_content: '想一想' } }] })
    if (tool) {
      data(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'Read', arguments: '' } }] } }] })
      for (const chunk of ['{"path":', '"a"}']) data(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: chunk } }] } }] })
    } else for (const chunk of ['O', 'K']) data(res, { choices: [{ delta: { content: chunk } }] })
    data(res, { choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })
    if (usage) data(res, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } })
    if (!missingEnd) res.write('data: [DONE]\n\n')
  }
  res.end()
}
async function setup(accept: string, upstream: string, handler?: (body: Wire, res: ServerResponse) => void) {
  const seen: Wire[] = [], auth: Array<string | undefined> = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); seen.push(body); auth.push(req.headers.authorization ?? req.headers['x-api-key'] as string)
    if (handler) handler(body, res); else reply(res, upstream === 'anthropic-messages', seen.length === 1)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const bridge = createProviderBridge({ resolveSecret: () => 'synthetic-upstream-key', keepAliveMs: 5 })
  cleanups.push(() => bridge.close())
  const route = await bridge.open({ id: 'test', protocol: upstream, baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKeyEnv: 'TEST_KEY' }, accept, { model: 'actual-model' })
  const url = route.provider.baseURL + (accept === 'anthropic-messages' ? '/v1/messages?beta=true' : '/responses')
  const send = (body: Wire, token = route.env.TAKT_BRIDGE_TOKEN!) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return { route, bridge, url, seen, auth, send }
}
function events(raw: string): Wire[] { return raw.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5))) }

for (const [accept, upstream] of [['anthropic-messages', 'openai-chat'], ['openai-responses', 'openai-chat'], ['openai-responses', 'anthropic-messages']]) describe(`${accept} ← ${upstream}`, () => {
  const anth = accept === 'anthropic-messages', base = anth ? claudeRequest : codexRequest
  it('抓包结构：工具往返、思考原样带回、跨用户回合清除、完整事件及用量', async () => {
    const f = await setup(accept!, upstream!)
    const first = events(await (await f.send(base)).text())
    expect(f.auth[0]).toBe(upstream === 'openai-chat' ? 'Bearer synthetic-upstream-key' : 'synthetic-upstream-key')
    expect(f.seen[0]).toMatchObject({ model: 'actual-model', stream: true })
    expect(f.seen[0]).not.toHaveProperty('metadata')
    expect(JSON.stringify(f.seen[0])).toContain(anth ? '中途系统占位' : '开发指令')
    expect(JSON.stringify(f.seen[0]!.tools)).not.toContain('web_search')
    expect(first[0]!.type).toBe(anth ? 'message_start' : 'response.created')
    expect(first.at(-1)!.type).toBe(anth ? 'message_stop' : 'response.completed')
    let round: Wire
    if (anth) {
      const thinking = first.find(e => e.delta?.type === 'signature_delta')!.delta.signature
      expect(first.find(e => e.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 12, output_tokens: 4 } })
      round = { ...base, messages: [...claudeRequest.messages, { role: 'assistant', content: [{ type: 'thinking', thinking: '想一想', signature: thinking }, { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '文件内容', is_error: true }] }] }
    } else {
      const result = first.at(-1)!.response
      expect(result).toMatchObject({ usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 2 } } })
      expect(result.output).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call-1', name: 'Read', arguments: '{"path":"a"}' }))
      round = { ...base, input: [...codexRequest.input, ...result.output, { type: 'function_call_output', call_id: 'call-1', output: '文件内容' }] }
    }
    const second = events(await (await f.send(round)).text())
    expect(second.at(-1)!.type).toBe(anth ? 'message_stop' : 'response.completed')
    const wire = f.seen[1]!
    if (upstream === 'openai-chat') expect(wire.messages).toContainEqual(expect.objectContaining({ role: 'assistant', reasoning_content: '想一想', tool_calls: expect.any(Array) }))
    else expect(wire.messages.find((m: Wire) => m.role === 'assistant').content).toContainEqual({ type: 'thinking', thinking: '想一想', signature: 'upstream-signature' })
    expect(JSON.stringify(wire)).toContain('文件内容')
    const final = { ...round, [anth ? 'messages' : 'input']: [...round[anth ? 'messages' : 'input'], { role: 'user', content: '新一轮问题' }] }
    await (await f.send(final)).text()
    expect(JSON.stringify(f.seen[2])).not.toContain('想一想')
  })
  it('纯文本、非流式、结构化输出降级为提示', async () => {
    const f = await setup(accept!, upstream!, (_, res) => reply(res, upstream === 'anthropic-messages'))
    const result = await (await f.send({ ...base, stream: false, text: { format: { type: 'json_schema', schema: { type: 'object' } } } })).json()
    expect(anth ? result.content.at(-1).text : result.output.at(-1).content[0].text).toBe('OK')
    expect(f.seen[0]).not.toHaveProperty('response_format')
    if (!anth) expect(JSON.stringify(f.seen[0])).toContain('最终回复必须是满足以下 JSON Schema 的 JSON')
  })
  it.each([400, 401, 429, 500, 503])('HTTP %s 原样透传且不回显上游凭据', async status => {
    const f = await setup(accept!, upstream!, (_, res) => { res.writeHead(status); res.end('synthetic-upstream-key') })
    for (const stream of [false, true]) {
      const response = await f.send({ ...base, stream }); expect(response.status).toBe(status)
      const raw = await response.text(); expect(raw).not.toContain('synthetic-upstream-key')
      if (!anth && stream) expect(events(raw).at(-1)!.type).toBe('response.failed')
      else expect(JSON.parse(raw).error.message).toContain(String(status))
    }
  })
  it('厂商错误原因带给 harness（流式与非流式）', async () => {
    const f = await setup(accept!, upstream!, (_, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Model Not Exist', type: 'invalid_request_error' } })) })
    for (const stream of [false, true]) {
      const raw = await (await f.send({ ...base, stream })).text()
      expect(raw).toContain('上游返回 HTTP 400：Model Not Exist')
    }
  })
  it('上游流中断不误报完成', async () => {
    const f = await setup(accept!, upstream!, (_, res) => reply(res, upstream === 'anthropic-messages', false, true))
    const value = events(await (await f.send(base)).text())
    expect(value.at(-1)!.type).toBe(anth ? 'error' : 'response.failed')
    expect(value.some(v => ['message_stop', 'response.completed'].includes(v.type))).toBe(false)
  })
  it('等待上游增量时持续保活', async () => {
    const f = await setup(accept!, upstream!, (_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); setTimeout(() => { if (upstream === 'anthropic-messages') data(res, { type: 'message_stop' }); else res.write('data: [DONE]\n\n'); res.end() }, 35) })
    expect(await (await f.send(base)).text()).toContain(anth ? 'event: ping' : ': keep-alive')
  })
})

it('Codex 命名空间工具展平去重（不同 MCP 服务的同名工具），调用与历史还原成 name + namespace', async () => {
  const f = await setup('openai-responses', 'openai-chat', (_, res) => {
    data(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'mcp__node_repl__js', arguments: '{"code":"1"}' } }] }, finish_reason: 'tool_calls' }] }); res.end('data: [DONE]\n\n')
  })
  const fn = (name: string) => ({ type: 'function', name, description: name, parameters: { type: 'object', properties: {} } })
  const long = 'x'.repeat(70)
  const request = { model: 'm', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], tools: [
    fn('exec_command'), { type: 'namespace', name: 'mcp__cua_repl', tools: [fn('js'), fn('js_reset')] }, { type: 'namespace', name: 'mcp__node_repl', tools: [fn('js'), fn('js_reset')] },
    { type: 'namespace', name: 'mcp__long', tools: [fn(long)] }] }
  const result = events(await (await f.send(request)).text()).at(-1)!.response
  const names = f.seen[0]!.tools.map((t: Wire) => t.function.name)
  expect(names.slice(0, 5)).toEqual(['exec_command', 'mcp__cua_repl__js', 'mcp__cua_repl__js_reset', 'mcp__node_repl__js', 'mcp__node_repl__js_reset'])
  expect(names[5]).toHaveLength(64)
  expect(new Set(names).size).toBe(names.length)
  expect(result.output[0]).toMatchObject({ type: 'function_call', name: 'js', namespace: 'mcp__node_repl', call_id: 'c1' })
  await (await f.send({ ...request, input: [...request.input, ...result.output, { type: 'function_call_output', call_id: 'c1', output: '1' }] })).text()
  expect(f.seen[1]!.messages).toContainEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__node_repl__js', arguments: '{"code":"1"}' } }] })
})

it('TRAE custom grammar 转函数并还原 custom_tool_call 与下一轮 output', async () => {
  const f = await setup('openai-responses', 'openai-chat', (_, res) => {
    data(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'exec', arguments: '{"input":"ls"}' } }] }, finish_reason: 'tool_calls' }] }); res.end('data: [DONE]\n\n')
  })
  const result = events(await (await f.send(traeRequest)).text()).at(-1)!.response
  expect(result.output[0]).toMatchObject({ type: 'custom_tool_call', name: 'exec', input: 'ls', call_id: 'c1' })
  expect(f.seen[0]!.tools[0].function).toMatchObject({ description: expect.stringContaining('lark'), parameters: { required: ['input'] } })
  await (await f.send({ ...traeRequest, input: [...traeRequest.input, ...result.output, { type: 'custom_tool_call_output', call_id: 'c1', output: 'file' }] })).text()
  expect(f.seen[1]!.messages).toContainEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"input":"ls"}' } }] })
})
it('令牌、路由关闭、models/count_tokens、本地密钥缺失与端口释放', async () => {
  vi.stubEnv('NO_PROXY', 'old-host'); vi.stubEnv('no_proxy', 'lower-host')
  const f = await setup('openai-responses', 'openai-chat')
  expect(f.route.env.NO_PROXY).toBe('old-host,127.0.0.1,localhost')
  expect(f.route.env.no_proxy).toBe('lower-host,127.0.0.1,localhost')
  expect((await f.send(codexRequest, 'bad')).status).toBe(401)
  const models = await fetch(f.route.provider.baseURL + '/models', { headers: { 'x-api-key': f.route.env.TAKT_BRIDGE_TOKEN! } })
  expect(await models.json()).toMatchObject({ data: [{ id: 'actual-model' }] })
  await f.route.close(); expect((await f.send(codexRequest)).status).toBe(404)
  await f.bridge.close()
  const server = createServer(); server.listen(Number(new URL(f.url).port), '127.0.0.1'); await once(server, 'listening'); await new Promise<void>(resolve => server.close(() => resolve()))
  const bridge = createProviderBridge({ resolveSecret: () => undefined }); cleanups.push(() => bridge.close())
  const route = await bridge.open({ id: 'missing', protocol: 'openai-chat', apiKeyEnv: 'NO_KEY' }, 'anthropic-messages')
  const call = (suffix: string) => fetch(route.provider.baseURL + suffix, { method: 'POST', headers: { 'x-api-key': route.env.TAKT_BRIDGE_TOKEN! }, body: JSON.stringify(claudeRequest) })
  expect(await (await call('/v1/messages/count_tokens?beta=true')).json()).toMatchObject({ input_tokens: expect.any(Number) })
  const denied = await call('/v1/messages'); expect(denied.status).toBe(401); expect(await denied.json()).toMatchObject({ error: { message: '缺少密钥 NO_KEY' } })
})
it('未返回 usage 时缺省零；仅支持规定的三对转换', async () => {
  const f = await setup('openai-responses', 'openai-chat', (_, res) => reply(res, false, false, false, false))
  const result = events(await (await f.send(codexRequest)).text()).at(-1)!.response
  expect(result.usage.total_tokens).toBe(0)
  for (const [a, u] of [['openai-chat', 'anthropic-messages'], ['openai-responses', 'gemini'], ['anthropic-messages', 'anthropic-messages']]) expect(f.bridge.supports(a!, u!)).toBe(false)
})

it.each(['signal', 'disconnect', 'route', 'bridge'])('取消 %s 会中止上游流', async kind => {
  let closed!: () => void, arrived!: () => void
  const upstreamClosed = new Promise<void>(resolve => { closed = resolve }), received = new Promise<void>(resolve => { arrived = resolve })
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* 消费请求后保持流打开。 */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); arrived(); res.once('close', closed)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const bridge = createProviderBridge(); cleanups.push(() => bridge.close())
  const controller = new AbortController(), requestController = new AbortController()
  const route = await bridge.open({ id: 'cancel', protocol: 'openai-chat', baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, 'openai-responses', { signal: controller.signal })
  const pending = fetch(route.provider.baseURL + '/responses', { method: 'POST', headers: { 'x-api-key': route.env.TAKT_BRIDGE_TOKEN! }, body: JSON.stringify({ input: 'OK', stream: true }), signal: requestController.signal }).then(r => r.text()).catch(() => '')
  await received
  if (kind === 'signal') controller.abort()
  if (kind === 'disconnect') requestController.abort()
  if (kind === 'route') await route.close()
  if (kind === 'bridge') await bridge.close()
  await upstreamClosed; await pending
})
it('图片、tool_choice、长度与采样参数映射，redacted_thinking 不转发', async () => {
  const f = await setup('anthropic-messages', 'openai-chat', (_, res) => reply(res, false))
  await (await f.send({ ...claudeRequest, messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'FAKE' } }, { type: 'image', source: { type: 'url', url: 'https://image.invalid/a' } }, { type: 'text', text: '图' }, { type: 'redacted_thinking', data: 'hidden' },
  ] }], tool_choice: { type: 'tool', name: 'Read' }, temperature: 0.3, top_p: 0.8, stop_sequences: ['END'] })).text()
  expect(f.seen[0]).toMatchObject({ max_tokens: 4096, temperature: 0.3, top_p: 0.8, stop: ['END'], tool_choice: { type: 'function', function: { name: 'Read' } } })
  expect(f.seen[0]!.messages[1].content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,FAKE' } }, { type: 'image_url', image_url: { url: 'https://image.invalid/a' } }, { type: 'text', text: '图' }])
})
it('并行工具参数交错仍在块 stop 前发出，拆分名字不会截断', async () => {
  const f = await setup('anthropic-messages', 'openai-chat', (_, res) => {
    for (const calls of [
      [{ index: 0, id: 'c0', function: { name: 'Re', arguments: '' } }],
      [{ index: 0, function: { name: 'ad', arguments: '{' } }, { index: 1, id: 'c1', function: { name: 'Write', arguments: '{' } }],
      [{ index: 0, function: { arguments: '}' } }, { index: 1, function: { arguments: '}' } }],
    ]) data(res, { choices: [{ delta: { tool_calls: calls } }] })
    res.end('data: [DONE]\n\n')
  })
  const output = events(await (await f.send(claudeRequest)).text())
  expect(output.filter(e => e.type === 'content_block_start').map(e => e.content_block.name)).toEqual(['Read', 'Write'])
  for (const index of [0, 1]) {
    const stop = output.findIndex(e => e.type === 'content_block_stop' && e.index === index)
    expect(stop).toBeGreaterThan(output.map((e, i) => e.type === 'content_block_delta' && e.index === index ? i : -1).reduce((a, b) => Math.max(a, b)))
  }
})
it('Responses 的思考、正文与工具合并为同一 assistant 回合；工具错误保留语义', async () => {
  const { encodeThinking } = await import('./wire.js')
  const f = await setup('openai-responses', 'openai-chat', (_, res) => reply(res, false))
  await (await f.send({ ...codexRequest, input: [...codexRequest.input,
    { type: 'reasoning', encrypted_content: encodeThinking('工具思考') },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先读文件' }] },
    { type: 'function_call', call_id: 'a', name: 'Read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: '内容' },
  ] })).text()
  expect(f.seen[0]!.messages.filter((m: Wire) => m.role === 'assistant')).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '先读文件' }], reasoning_content: '工具思考', tool_calls: [{ id: 'a', type: 'function', function: { name: 'Read', arguments: '{}' } }] }])
})
