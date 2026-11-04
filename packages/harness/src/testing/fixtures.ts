import type { CliHarnessConfig } from '@taktflow/core'
import type { MockScript } from '../mock.js'
import type { ConformanceFixtures, FixtureSource, SuccessFixture } from './conformance.js'

export const synthetic: FixtureSource = {
  kind: 'synthetic', description: '手写协议样例；参考 root parser 测试及 adapters 源码，非 CLI 实录',
}
export const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] }
export const structuredText = '完成\n```json\n{"verdict":"pass"}\n```'
export const errorCases = ['HTTP 429 rate_limit', 'HTTP 503 overloaded', 'HTTP 401 ACCOUNT_SIGN_IN_REQUIRED Sign in', 'timeout']
export const jsonl = (...events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n')

export function streamFixtures(
  stream: (finalText: string) => string,
  error: (message: string) => string,
  expected: SuccessFixture['expected'],
  description?: string,
): ConformanceFixtures {
  const source = description ? { ...synthetic, description } : synthetic
  return {
    success: { name: '完整事件流', source, input: stream(expected.finalText), expected: { sessionId: expected.started.sessionId, ...expected } },
    structured: { name: 'JSON 代码块', source, input: stream(structuredText), schema, expected: { verdict: 'pass' } },
    errors: errorCases.map(message => ({ name: message, source, input: error(message), keywords: message.split(' ') })),
  }
}

export const claudeFixtures = streamFixtures(text => jsonl(
  { type: 'system', subtype: 'init', session_id: 'claude-s', model: 'opus' },
  { type: 'assistant', message: { content: [{ type: 'text', text: '读取文件' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'source' }] } },
  { type: 'result', is_error: false, result: text, session_id: 'claude-s',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 }, total_cost_usd: 0.12 },
), message => jsonl({ type: 'error', message }), {
  started: { type: 'started', sessionId: 'claude-s', model: 'opus' },
  message: { type: 'message', role: 'assistant', text: '读取文件' },
  toolCall: { type: 'tool_call', tool: 'Read', input: '{"file_path":"a.ts"}', output: 'source', ok: true },
  usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30, costUsd: 0.12 }, finalText: '完成',
}, '从 claude-code.test.ts 合成 fixture 精简并保持同一 session；非实录')

export const codexFixtures = streamFixtures(text => jsonl(
  { type: 'thread.started', thread_id: 'thread-1' },
  { type: 'item.completed', item: { type: 'agent_message', text: '计划' } },
  { type: 'item.completed', item: { type: 'command_execution', command: 'cat a.ts', aggregated_output: 'source', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 30 } },
), message => jsonl({ type: 'turn.failed', error: { message } }), {
  started: { type: 'started', sessionId: 'thread-1' },
  message: { type: 'message', role: 'assistant', text: '计划' },
  toolCall: { type: 'tool_call', tool: 'command_execution', input: 'cat a.ts', output: 'source', ok: true },
  usage: { inputTokens: 200, outputTokens: 30, cachedTokens: 50 }, finalText: '最终回答',
}, '沿用 codex.test.ts 合成 fixture 的事件字段；非实录')

export const dshFixtures = streamFixtures(text => jsonl(
  { type: 'session', sessionId: 'dsh-s' },
  { type: 'text', text: '读取文件' },
  { type: 'tool_call', callId: 'c1', tool: 'read', input: { path: 'a' } },
  { type: 'tool_result', callId: 'c1', status: 'completed', result: 'source' },
  { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 } },
  { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 130, outputTokens: 30, cacheReadTokens: 60 } },
  { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
  { type: 'final', text },
), message => jsonl({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message } } }), {
  started: { type: 'started', sessionId: 'dsh-s' },
  message: { type: 'message', role: 'assistant', text: '读取文件' },
  toolCall: { type: 'tool_call', tool: 'read', input: '{"path":"a"}', output: 'source', ok: true },
  usage: { inputTokens: 230, outputTokens: 50, cachedTokens: 100 },
  usageEvents: [{ inputTokens: 100, outputTokens: 20, cachedTokens: 40 }, { inputTokens: 130, outputTokens: 30, cachedTokens: 60 }],
  finalText: '完整最终回答',
}, '沿用 dsh.test.ts 基于 0.2.1-rc.3 ASAR 形状的合成样例；非实录')

export const genericConfig: CliHarnessConfig = {
  id: 'conformance-generic', kind: 'cli', command: ['fixture-cli'], output: {
    format: 'jsonl', events: { type: 'event.kind', sessionId: 'event.session', text: 'event.text',
      tool: 'event.tool', toolInput: 'event.input', inputTokens: 'event.usage.input', outputTokens: 'event.usage.output',
      final: { field: 'event.kind', equals: 'final' } },
  },
}
export const genericFixtures = streamFixtures(text => jsonl(
  { event: { kind: 'started', session: 'generic-s' } },
  { event: { kind: 'message', text: '读取文件' } },
  { event: { kind: 'tool_call', tool: 'read', input: { path: 'a' } } },
  { event: { kind: 'usage', usage: { input: 100, output: 20 } } },
  { event: { kind: 'final', text } },
), message => jsonl({ event: { kind: 'error', text: message } }), {
  started: { type: 'started', sessionId: 'generic-s' },
  message: { type: 'message', role: 'assistant', text: '读取文件' },
  toolCall: { type: 'tool_call', tool: 'read', input: '{"path":"a"}' },
  usage: { inputTokens: 100, outputTokens: 20 }, finalText: '完成',
})

export const mockFixtures: ConformanceFixtures<MockScript> = {
  success: {
    name: '原生 mock 剧本', source: synthetic,
    request: { sessionId: 'mock-s', model: 'mock-model' },
    input: { steps: [{ finalText: '完成', toolCalls: [{ tool: 'read', input: 'a', output: 'source' }], usage: { inputTokens: 100, outputTokens: 20 } }] },
    expected: { started: { type: 'started', sessionId: 'mock-s', model: 'mock-model' },
      message: { type: 'message', role: 'assistant', text: '完成' },
      toolCall: { type: 'tool_call', tool: 'read', input: 'a', output: 'source' },
      usage: { inputTokens: 100, outputTokens: 20 }, finalText: '完成' },
  },
  structured: { name: 'mock structured 剧本', source: synthetic, input: { steps: [{ structured: { verdict: 'pass' } }] },
    schema, expected: { verdict: 'pass' } },
  errors: errorCases.map(message => ({ name: message, source: synthetic, input: { steps: [{ fail: message }] }, keywords: message.split(' ') })),
}
