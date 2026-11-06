import { afterEach, expect, it, vi } from 'vitest'
import type { GraphNode } from '../api.js'
import type { EventEnvelope, RunState } from '../types.js'
import { budgetUsage } from '../util/budget.js'
import { budgetStatus } from './budget.js'
import { currentNode } from './current-node.js'

const run: RunState = { runId: 'run-1', workflowId: 'test', workflowVersion: '1', requirementId: 'REQ-1', status: 'running', startedAt: '2026-11-06T00:00:00.000Z', args: {}, nodes: {}, expansions: [] }
const usage: EventEnvelope<'harness.usage'> = { runId: run.runId, type: 'harness.usage', data: { inputTokens: 60, outputTokens: 20, costUsd: 0.4 }, seq: 1, ts: run.startedAt, actor: { type: 'system', id: 'test' }, hash: '', prevHash: '' }
afterEach(() => { vi.useRealTimers() })
it('只累计本运行 harness 用量，共用预算口径；已结束运行冻结耗时', () => {
  const state = { ...run, endedAt: '2026-11-06T00:08:00.000Z', budget: { tokens: 100, costUsd: 1, minutes: 10, concurrency: 2 } }
  const events: EventEnvelope[] = [usage, { ...usage, runId: 'other' }, { ...usage, type: 'node.finished', data: { status: 'succeeded', outputs: [], usage: usage.data } }]
  const status = budgetStatus(state, events)
  expect(status).toMatchObject({ used: { tokens: 80, costUsd: 0.4, minutes: 8 }, ratio: 0.8, state: 'warning' })
  expect({ ratio: status.ratio, state: status.state }).toEqual(budgetUsage(state.budget, status.used))
  expect(budgetStatus(state, [usage, { ...usage, seq: 2 }]).state).toBe('exhausted')
})
it('运行中耗时随时钟更新，无预算为 ok，缺失成本保持未知', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T00:10:00.000Z'))
  expect(budgetStatus(run, [])).toEqual({ budget: {}, used: { tokens: 0, minutes: 10 }, ratio: 0, state: 'ok' })
  expect(budgetStatus({ ...run, budget: { minutes: 10 } }, []).state).toBe('exhausted')
  expect(budgetStatus(run, [{ ...usage, data: { inputTokens: 2, outputTokens: 1 } }]).used.costUsd).toBeUndefined()
})
it('当前节点优先等待人的叶节点，读取 runtime 状态，没有活跃节点时为空', () => {
  const node = (id: string, status: GraphNode['status'], parent?: string): GraphNode => ({ id, status, parent, title: id, kind: parent ? 'agent' : 'loop', attempts: 1 })
  const graph = { edges: [], nodes: [node('loop', 'running'), node('dev', 'running', 'loop'), node('approve', 'waiting_human', 'loop')] }
  expect(currentNode(run, graph)).toEqual({ runId: run.runId, nodeId: 'approve', title: 'approve', status: 'waiting_human' })
  expect(currentNode({ ...run, nodes: { approve: { id: 'approve', status: 'succeeded', attempts: 1, outputs: [] } } }, graph)?.nodeId).toBe('dev')
  expect(currentNode(run, { nodes: [node('finished', 'succeeded')], edges: [] })).toBeUndefined()
})
