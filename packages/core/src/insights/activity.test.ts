import { expect, it } from 'vitest'
import type { EventEnvelope, EventPayloads, EventType } from '../types.js'
import { nodeActivity } from './activity.js'
const at = (seconds: number) => new Date(seconds * 1000).toISOString()
function event<T extends EventType>(type: T, data: EventPayloads[T], seq: number): EventEnvelope {
  return { type, data, ts: at(seq), seq, runId: 'r', nodeId: 'n', actor: { type: 'system', id: 'test' } } as EventEnvelope
}
it('最近尝试中推导思考、并行工具、压缩、等工具，终态不显示活动', () => {
  const events = [event('node.started', { attempt: 1 }, 0)]
  expect(nodeActivity(events, 0)).toEqual({ state: 'thinking', since: at(0) })
  events.push(event('harness.tool_call', { tool: 'read', input: 'a', callId: 'a', phase: 'start' }, 1))
  events.push(event('harness.tool_call', { tool: 'bash', input: 'b', callId: 'b', phase: 'start' }, 2))
  events.push(event('harness.message', { role: 'assistant', text: 'still working' }, 3))
  events.push(event('harness.tool_call', { tool: 'bash', input: 'b', callId: 'b', phase: 'end' }, 4))
  expect(nodeActivity(events, 10_000)).toEqual({ state: 'tool', tool: 'read', input: 'a', since: at(1) })
  events.push(event('harness.tool_call', { tool: 'read', input: 'a', callId: 'a', phase: 'end' }, 5))
  expect(nodeActivity(events, 30_000)?.state).toBe('thinking')
  events.push(event('context.compacted', { nodeId: 'n', at: at(6), trigger: 'auto', beforeTokens: 80, afterTokens: 20, summary: '', dropped: [] }, 6))
  expect(nodeActivity(events)?.state).toBe('compacting')
  events.push(event('harness.tool_call', { tool: 'old', input: 'x', output: 'done' }, 7))
  expect(nodeActivity(events, 21_000)?.state).toBe('thinking')
  expect(nodeActivity(events, 22_000)?.state).toBe('waiting_tool')
  events.push(event('node.finished', { status: 'succeeded', outputs: [] }, 8))
  expect(nodeActivity(events)).toBeUndefined()
  events.push(event('node.started', { attempt: 2 }, 9))
  expect(nodeActivity(events)).toEqual({ state: 'thinking', since: at(9) })
  expect(nodeActivity([])).toBeUndefined()
})

it('连续的思考片段不重置开始时间；工具结束后的思考从结束时算', () => {
  const events = [event('node.started', { attempt: 1 }, 0), event('harness.started', { harness: 'h' } as EventPayloads['harness.started'], 1)]
  for (let i = 2; i < 6; i++) events.push(event('harness.message', { role: 'assistant', text: `片段 ${i}` }, i))
  expect(nodeActivity(events, 6_000)).toEqual({ state: 'thinking', since: at(1) })
  events.push(event('harness.tool_call', { tool: 'read', input: 'a', callId: 'a', phase: 'start' }, 6))
  events.push(event('harness.tool_call', { tool: 'read', input: 'a', callId: 'a', phase: 'end' }, 7))
  events.push(event('harness.message', { role: 'assistant', text: '继续' }, 8))
  expect(nodeActivity(events, 9_000)).toEqual({ state: 'thinking', since: at(7) })
})
