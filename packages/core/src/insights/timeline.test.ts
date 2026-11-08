import { expect, it } from 'vitest'
import type { EventEnvelope, EventPayloads, EventType, RunState, WorkflowDefinition } from '../types.js'
import { snapshotWorkflow } from '../store/snapshot.js'
import { runTimeline } from './timeline.js'
const at = (seconds: number) => new Date(seconds * 1000).toISOString()
it('时间线保留 queue、wait、fallback 调用、两拍工具、压缩与输入 token', () => {
  const workflow: WorkflowDefinition = { id: 'w', title: 'w', version: '1', stages: [], nodes: [{ id: 'n', kind: 'agent', role: 'dev', prompt: 'work' }] }
  const state: RunState = { runId: 'r', requirementId: 'REQ-001', workflowId: 'w', workflowVersion: '1', status: 'running', startedAt: at(0), args: {}, expansions: [], nodes: { n: { id: 'n', status: 'running', attempts: 1, outputs: [] } } }
  const events: EventEnvelope[] = []
  const emit = <T extends EventType>(type: T, data: EventPayloads[T], seconds: number) => events.push({ type, data, seq: events.length + 1, ts: at(seconds), runId: 'r', nodeId: 'n', actor: { type: 'agent', role: 'dev', harness: 'h', invocationId: seconds < 30 ? 'i1' : 'i2' } } as EventEnvelope)
  emit('node.ready', {}, 0); emit('node.started', { attempt: 1 }, 1)
  const invocation = (id: string, harness: string) => ({ id, harness, nodeId: 'n', attempt: 1, role: 'producer' as const, fallbackIndex: id === 'i1' ? 0 : 1, model: { requested: 'wanted', resolved: 'resolved' }, effort: {}, skills: [], at: at(2) })
  emit('invocation.started', invocation('i1', 'h1'), 2)
  emit('harness.started', { harness: 'h1', contextWindow: 100 }, 3)
  emit('harness.tool_call', { tool: 'bash', input: 'build', phase: 'start', callId: 'c' }, 4)
  emit('harness.tool_call', { tool: 'bash', input: 'build', phase: 'end', callId: 'c', ok: false }, 21)
  emit('harness.usage', { inputTokens: 80, outputTokens: 10, cachedTokens: 30 }, 22)
  emit('invocation.finished', { id: 'i1', outcome: 'error', durationMs: 23000 }, 25)
  emit('invocation.started', invocation('i2', 'h2'), 30)
  emit('context.compacted', { nodeId: 'n', at: at(31), trigger: 'auto', beforeTokens: 80, afterTokens: 20, summary: '', dropped: [] }, 31)
  emit('harness.message', { role: 'assistant', text: 'go' }, 32)
  emit('harness.tool_call', { tool: 'read', input: 'a', phase: 'start', callId: 'c' }, 33)
  const result = runTimeline(state, events, snapshotWorkflow(workflow), 50_000)
  const lane = result.lanes[0]!
  expect(lane.invocations).toMatchObject([{ id: 'i1', harness: 'h1', outcome: 'error' }, { id: 'i2', harness: 'h2' }])
  expect(lane.invocations![0]!.model).toBeUndefined()
  expect(lane.segments).toContainEqual(expect.objectContaining({ kind: 'tool', start: at(4), end: at(21), invocationId: 'i1', long: true }))
  expect(lane.segments.at(-1)).toMatchObject({ kind: 'tool', start: at(33), invocationId: 'i2', long: true })
  expect(lane.segments.at(-1)!.end).toBeUndefined()
  expect(result.context[0]).toEqual({ nodeId: 'n', window: 100, points: [{ at: at(22), tokens: 80 }], compactions: [{ at: at(31), before: 80, after: 20 }] })
  emit('human.requested', { requestId: 'human', ask: 'why', form: 'answer' }, 51)
  emit('human.answered', { requestId: 'human', answer: 'yes' }, 60)
  expect(runTimeline(state, events, snapshotWorkflow(workflow)).lanes[0]!.segments).toContainEqual(expect.objectContaining({ kind: 'wait', start: at(51), end: at(60), requestId: 'human' }))
})
it('loop 与 planner 展开保留 parent，旧运行没有事件也可读', () => {
  const snapshot = snapshotWorkflow({ id: 'w', title: 'w', version: '1', stages: [], nodes: [{ id: 'loop', kind: 'loop', maxIterations: 2, body: [{ id: 'child', kind: 'script', run: 'true' }] }, { id: 'plan', kind: 'planner', role: 'planner', prompt: '', expand: () => [] }] } as WorkflowDefinition)
  const state = { runId: 'r', startedAt: at(0), nodes: {}, expansions: [{ plannerId: 'plan', items: [], nodeIds: ['plan/task'], nodes: [{ id: 'plan/task', kind: 'agent', title: 'task', needs: [] }] }] } as unknown as RunState
  const result = runTimeline(state, [], snapshot)
  expect(result.lanes.find(lane => lane.nodeId === 'loop/child')?.parent).toBe('loop')
  expect(result.lanes.find(lane => lane.nodeId === 'plan/task')?.parent).toBe('plan')
  expect(result.context).toEqual([])
})
