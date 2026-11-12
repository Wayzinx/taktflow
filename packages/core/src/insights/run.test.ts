import { describe, expect, it } from 'vitest'
import type { NodeState, RunState } from '../types.js'
import { summarizeRun } from './run.js'

const runtime = (id: string, status: NodeState['status']): NodeState => ({ id, status, attempts: 0, outputs: [] })
const state: RunState = {
  runId: 'run-1', requirementId: 'REQ-001', workflowId: 'wf', workflowVersion: '1',
  status: 'failed', startedAt: '2026-11-09T00:00:00Z', args: {}, expansions: [],
  nodes: { clarify: runtime('clarify', 'failed'), prd: runtime('prd', 'pending'), loop: runtime('loop', 'pending') },
}

describe('summarizeRun progress', () => {
  it('只统计已实例化节点，未展开的循环体不加入进度分母', () => {
    expect(summarizeRun(state, []).progress).toEqual({ total: 3, done: 0, failed: 1 })
  })
  it('跳过算完成，失败和阻塞算失败，其他状态不算完成', () => {
    const nodes = ['succeeded', 'skipped', 'failed', 'blocked', 'running', 'cancelled', 'stale']
      .map((status, i) => runtime(String(i), status as NodeState['status']))
    expect(summarizeRun({ ...state, nodes: Object.fromEntries(nodes.map(node => [node.id, node])) }, []).progress).toEqual({ total: 7, done: 2, failed: 2 })
  })
})
