import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessEvent } from '@taktflow/core'
import { createClaudeCodeHarness, createClaudeCodeParser } from './claude-code.js'
import { createCodexHarness, createCodexParser } from './codex.js'
import { createDshHarness, createDshParser } from './dsh.js'
import { createGeminiCliHarness, createGeminiCliParser } from './adapters/gemini-cli.js'
import { createCursorAgentHarness, createCursorAgentParser } from './adapters/cursor-agent.js'
import { createQwenCodeHarness, createQwenCodeParser } from './adapters/qwen-code.js'
import { createKimiCliHarness, createKimiCliParser } from './adapters/kimi-cli.js'
import { createPiHarness, createPiParser } from './adapters/pi.js'
import { createOpenCodeHarness, createOpenCodeParser } from './adapters/opencode.js'
import { createCliHarness } from './adapters/cli-generic.js'
import { createMockHarness } from './mock.js'
const claude = [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'read', input: { path: 'a' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'body' }] } }]
afterEach(() => vi.restoreAllMocks())
for (const [harness, parser, start, end] of [
  [createClaudeCodeHarness(), createClaudeCodeParser, claude[0], claude[1]],
  [createCursorAgentHarness(), createCursorAgentParser, claude[0], claude[1]],
  [createQwenCodeHarness(), createQwenCodeParser, claude[0], claude[1]],
  [createCodexHarness(), createCodexParser, { type: 'item.started', item: { id: 't', type: 'command_execution', command: 'pwd' } }, { type: 'item.completed', item: { id: 't', type: 'command_execution', command: 'pwd', aggregated_output: 'body', status: 'completed', exit_code: 0 } }],
  [createDshHarness(), createDshParser, { type: 'tool_call', callId: 't', tool: 'read', input: 'a' }, { type: 'tool_result', callId: 't', result: 'body', status: 'completed' }],
  [createGeminiCliHarness(), createGeminiCliParser, { type: 'tool_use', tool_id: 't', tool_name: 'read', parameters: 'a' }, { type: 'tool_result', tool_id: 't', status: 'success', output: 'body' }],
  [createKimiCliHarness(), createKimiCliParser, { role: 'assistant', tool_calls: [{ id: 't', function: { name: 'read', arguments: 'a' } }] }, { role: 'tool', tool_call_id: 't', content: 'body' }],
  [createPiHarness(), createPiParser, { type: 'tool_execution_start', toolCallId: 't', toolName: 'read', args: 'a' }, { type: 'tool_execution_end', toolCallId: 't', result: 'body', isError: false }],
] as const) it(`${harness.id} 两拍能力与实际开始/结束一致，时间来自两次观测`, () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const events: HarnessEvent[] = [], stream = parser(event => events.push(event))
  if (harness.id === 'pi') stream.onLine(JSON.stringify({ type: 'session', id: 's' }))
  stream.onLine(JSON.stringify(start))
  const first = events.filter(event => event.type === 'tool_call')
  expect(harness.capabilities).toMatchObject({ toolPhases: true, readOnly: false })
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ phase: 'start', callId: 't' })
  expect(first[0]!.output).toBeUndefined()
  clock.mockReturnValue(1750)
  stream.onLine(JSON.stringify(end))
  expect(events.filter(event => event.type === 'tool_call').at(-1)).toMatchObject({ phase: 'end', callId: 't', durationMs: 750, output: 'body', ok: true })
})
it('只有完成快照的适配器不虚构开始时间与两拍能力', () => {
  const events: HarnessEvent[] = []
  const parser = createOpenCodeParser(event => events.push(event))
  parser.onLine(JSON.stringify({ type: 'tool_use', part: { callID: 't', tool: 'read', state: { status: 'completed', input: 'a', output: 'body' } } }))
  expect(createOpenCodeHarness().capabilities?.toolPhases).toBe(false)
  expect(events.filter(event => event.type === 'tool_call')).toHaveLength(1)
  expect(events.find(event => event.type === 'tool_call')).not.toHaveProperty('phase')
  expect(createMockHarness({ steps: [] }).capabilities?.toolPhases).toBe(false)
  expect(createCliHarness({ id: 'generic', kind: 'cli', command: ['cli'], output: { format: 'text' } }).capabilities).toMatchObject({ toolPhases: false, modelOverride: false, effortOverride: false, readOnly: false })
})
