import { expect, it } from 'vitest'
import type { HarnessEvent } from '@taktflow/core'
import { createQwenCodeParser } from './qwen-code.js'

it('Qwen 合成 Claude 兼容格式保留消息、工具、用量及最终结果', () => {
  // 仅覆盖该兼容格式，未由真实 Qwen Code 录制。
  const events: HarnessEvent[] = []
  const parser = createQwenCodeParser(e => events.push(e))
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'q1', model: 'qwen-test' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '读取' }, { type: 'tool_use', id: 't', name: 'read_file', input: { path: 'a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'body', is_error: false }] } },
    { type: 'result', is_error: false, result: '完成', usage: { input_tokens: 6, output_tokens: 3 } },
  ]
  lines.forEach(line => parser.onLine(JSON.stringify(line)))
  expect(parser.result()).toEqual({ ok: true, sessionId: 'q1', finalText: '完成', usage: { inputTokens: 6, outputTokens: 3 } })
  expect(events).toContainEqual({ type: 'started', sessionId: 'q1', model: 'qwen-test' })
  expect(events).toContainEqual({ type: 'message', role: 'assistant', text: '读取' })
  expect(events).toContainEqual({ type: 'tool_call', tool: 'read_file', input: '{"path":"a"}', output: 'body', ok: true })
  expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 6, outputTokens: 3 } })
})
