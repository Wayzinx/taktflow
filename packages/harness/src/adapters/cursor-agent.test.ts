import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessEvent } from '@taktflow/core'
import { createClaudeCodeParser } from '../claude-code.js'
import { createCursorAgentParser } from './cursor-agent.js'

// 两个 parser 各自用 Date.now() 算工具耗时，慢机器上会差 1ms；冻结时钟让两边一致
afterEach(() => { vi.useRealTimers() })

it('Cursor 合成样例与复用的 Claude parser 结果和事件完全一致', () => {
  // 合成兼容格式，不是 Cursor 真实录制。
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'c1', model: 'test' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '读取' }, { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }] } },
    { type: 'result', is_error: false, result: '完成', usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 1 }, total_cost_usd: 0.01 },
  ]
  vi.useFakeTimers({ toFake: ['Date'] })
  const actual: HarnessEvent[] = []
  const expected: HarnessEvent[] = []
  const cursor = createCursorAgentParser(e => actual.push(e))
  const claude = createClaudeCodeParser(e => expected.push(e))
  lines.forEach(line => { cursor.onLine(JSON.stringify(line)); claude.onLine(JSON.stringify(line)) })
  expect(cursor.result()).toEqual(claude.result())
  expect(actual).toEqual(expected)
  expect(cursor.result()).toMatchObject({ ok: true, sessionId: 'c1', finalText: '完成', usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.01 } })
  expect(new Set(actual.map(e => e.type))).toEqual(new Set(['started', 'message', 'tool_call', 'usage']))
})
