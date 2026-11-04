import { createGeminiCliHarness, createGeminiCliParser } from '../adapters/gemini-cli.js'
import { createCursorAgentHarness, createCursorAgentParser } from '../adapters/cursor-agent.js'
import { createQwenCodeHarness, createQwenCodeParser } from '../adapters/qwen-code.js'
import { createKimiCliHarness, createKimiCliParser } from '../adapters/kimi-cli.js'
import { createOpenCodeHarness, createOpenCodeParser } from '../adapters/opencode.js'
import { parseHarnessStream, runHarnessConformance } from './index.js'
import { claudeFixtures, jsonl, streamFixtures } from './fixtures.js'

// 五个新增 CLI 均无实录；这些测试只证明所列合成协议和本地进程生命周期。
const geminiFixtures = streamFixtures(text => jsonl(
  { type: 'init', session_id: 'gemini-s', model: 'gemini-test' },
  { type: 'message', role: 'assistant', content: '读取文件' },
  { type: 'tool_use', tool_id: 't1', tool_name: 'read_file', parameters: { path: 'a' } },
  { type: 'tool_result', tool_id: 't1', status: 'success', output: 'source' },
  { type: 'message', role: 'assistant', content: text },
  { type: 'result', status: 'success', stats: { input_tokens: 100, output_tokens: 20, cached: 30 } },
), message => jsonl({ type: 'error', message }), {
  started: { type: 'started', sessionId: 'gemini-s', model: 'gemini-test' },
  message: { type: 'message', role: 'assistant', text: '读取文件' },
  toolCall: { type: 'tool_call', tool: 'read_file', input: '{"path":"a"}', output: 'source', ok: true },
  usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 }, finalText: '完成',
})

const kimiFixtures = streamFixtures(text => jsonl(
  { role: 'assistant', session_id: 'kimi-s', model: 'kimi-test', content: '读取文件',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
  { role: 'tool', tool_call_id: 't1', content: 'source' },
  { role: 'assistant', content: text, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } },
), message => jsonl({ type: 'error', message }), {
  started: { type: 'started', sessionId: 'kimi-s', model: 'kimi-test' },
  message: { type: 'message', role: 'assistant', text: '读取文件' },
  toolCall: { type: 'tool_call', tool: 'read', input: '{"path":"a"}', output: 'source', ok: true },
  usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 }, finalText: '完成',
})

const opencodeFixtures = streamFixtures(text => jsonl(
  { type: 'step_start', sessionID: 'opencode-s' },
  { type: 'tool_use', part: { callID: 't1', tool: 'read', state: { status: 'completed', input: { path: 'a' }, output: 'source' } } },
  { type: 'text', part: { text } },
  { type: 'step_finish', part: { id: 'p1', reason: 'stop', cost: 0.01, tokens: { input: 100, output: 20, cache: { read: 30 } } } },
), message => jsonl({ type: 'error', error: { name: 'APIError', data: { message } } }), {
  started: { type: 'started', sessionId: 'opencode-s' },
  message: { type: 'message', role: 'assistant', text: '完成' },
  toolCall: { type: 'tool_call', tool: 'read', input: '{"path":"a"}', output: 'source', ok: true },
  usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30, costUsd: 0.01 }, finalText: '完成',
})

for (const [name, parser, factory, fixtures] of [
  ['gemini-cli', createGeminiCliParser, createGeminiCliHarness, geminiFixtures],
  ['cursor-agent', createCursorAgentParser, createCursorAgentHarness, claudeFixtures],
  ['qwen-code', createQwenCodeParser, createQwenCodeHarness, claudeFixtures],
  ['kimi-cli', createKimiCliParser, createKimiCliHarness, kimiFixtures],
  ['opencode', createOpenCodeParser, createOpenCodeHarness, opencodeFixtures],
] as const) {
  runHarnessConformance(name, {
    parse: parseHarnessStream(parser), fixtures,
    runtime: { create: bin => factory({ bin }), replay: fixtures },
  })
}
