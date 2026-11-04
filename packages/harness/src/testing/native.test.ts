import type { ChatResponse, HarnessAdapter, ModelProvider } from '@taktflow/core'
import { createNativeHarness } from '../native/index.js'
import { runHarnessConformance, type ConformanceFixtures } from './conformance.js'

type Replay = Array<ChatResponse | Error>
const source = { kind: 'synthetic', description: '固定 ModelProvider 回包，不连接外部模型' } as const
const usage = { inputTokens: 10, outputTokens: 2 }
const end = (content: string): ChatResponse => ({ message: { role: 'assistant', content }, stopReason: 'end', usage })

function harness(chat: ModelProvider['chat']): HarnessAdapter {
  const native = createNativeHarness({ providers: { fixture: { id: 'fixture', protocol: 'openai-chat', available: async () => ({ ok: true }), chat } }, models: { replay: { provider: 'fixture', id: 'raw' } } })
  return { ...native, run: (req, emit) => native.run({ ...req, model: 'replay' }, emit) }
}

const fixtures: ConformanceFixtures<Replay> = {
  success: {
    name: '工具往返', source,
    input: [{ message: { role: 'assistant', content: 'listing', toolCalls: [{ id: 'list-1', name: 'list', arguments: '{}' }] }, stopReason: 'tool_calls', usage }, end('done')],
    expected: {
      started: { type: 'started', model: 'raw' }, message: { type: 'message', role: 'assistant', text: 'listing' },
      toolCall: { type: 'tool_call', tool: 'list', input: '{}', output: '', ok: true },
      usage: { inputTokens: 20, outputTokens: 4 }, usageEvents: [usage, usage], finalText: 'done',
    },
  },
  structured: { name: 'schema 结果', source, input: [end('{"ok":true}'), end('{"ok":true}')], schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, expected: { ok: true } },
  errors: ['HTTP 429 rate limit', 'HTTP 401 sign in', 'HTTP 503 overloaded'].map((error) => ({ name: error, source, input: [new Error(error)], keywords: error.split(' ') })),
}

runHarnessConformance('native', {
  fixtures,
  parse: (responses, emit, req) => {
    let index = 0
    return harness(async () => {
      const response = responses[index++]
      if (response instanceof Error) throw response
      if (!response) throw new Error('Replay exhausted')
      return response
    }).run(req, emit)
  },
  cancellation: () => harness(async () => new Promise(() => {})),
  timeout: () => harness(async () => new Promise(() => {})),
})
