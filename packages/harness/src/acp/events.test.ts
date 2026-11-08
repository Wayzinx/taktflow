import { expect, it } from 'vitest'
import type { HarnessCapabilities, HarnessEvent } from '@taktflow/core'
import { AcpEvents } from './events.js'

it('压缩按 ID 合并、summary 替换/清空/追加，不虚构 token 和触发原因', () => {
  const events: HarnessEvent[] = []
  const mapper = new AcpEvents(event => events.push(event), {})
  mapper.update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'one', content: { type: 'text', text: 'first' } })
  mapper.update({ sessionUpdate: 'compaction_update', compactionId: 'one', status: 'in_progress', summary: [{ type: 'text', text: 'replacement' }], error: 'old' })
  mapper.update({ sessionUpdate: 'compaction_update', compactionId: 'two', status: 'failed', error: 'other' })
  mapper.update({ sessionUpdate: 'compaction_update', compactionId: 'one', status: 'completed', error: null })
  expect(events.at(-1)).toEqual({ type: 'message', role: 'system', text: '[ACP compaction] {"compactionId":"one","status":"completed","summary":[{"type":"text","text":"replacement"}]}' })
  mapper.update({ sessionUpdate: 'compaction_update', compactionId: 'one', status: 'completed', summary: null })
  mapper.update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'one', content: { type: 'text', text: 'last' } })
  expect(JSON.stringify(events.at(-1))).not.toContain('replacement')
  expect(JSON.stringify(events.at(-1))).toContain('last')
  expect(events.every(event => event.type === 'message')).toBe(true)
})

it('工具部分更新合并，重复完成不发重复 end，无 start 的更新不伪造耗时', () => {
  const events: HarnessEvent[] = [], capabilities: HarnessCapabilities = {}
  const mapper = new AcpEvents(event => events.push(event), capabilities)
  mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'orphan', status: 'completed' })
  expect(events[0]?.type).toBe('message')
  mapper.update({ sessionUpdate: 'tool_call', toolCallId: 'a', kind: 'execute', title: 'run', rawInput: { command: 'pwd' } })
  mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'failed', rawOutput: { code: 1 } })
  mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'failed' })
  expect(events.filter(event => event.type === 'tool_call')).toEqual([
    { type: 'tool_call', tool: 'exec', phase: 'start', callId: 'a', input: '{"command":"pwd"}' },
    { type: 'tool_call', tool: 'exec', phase: 'end', callId: 'a', input: '{"command":"pwd"}', output: '{"code":1}', ok: false, durationMs: expect.any(Number) },
  ])
  expect(capabilities).toMatchObject({ toolEvents: true, toolPhases: true })
})

it('只有 agent 暴露的 select 选项开启模型/effort 能力；更新可撤销能力', () => {
  const capabilities: HarnessCapabilities = {}, mapper = new AcpEvents(() => {}, capabilities)
  mapper.configure([{ id: 'm', category: 'model', type: 'select' }, { id: 'e', category: 'thought_level', type: 'boolean' }])
  expect(capabilities).toEqual({ modelOverride: true, effortOverride: false })
  mapper.update({ sessionUpdate: 'config_option_update', configOptions: [] })
  expect(capabilities).toEqual({ modelOverride: false, effortOverride: false })
})
