import { expect, it } from 'vitest'
import type { RunState } from '../types.js'
import { propagateStale } from './stale.js'

it('按版本选种子，只传播 needs 和子到父，不变更输入、不扩散兄弟或产物同名边', () => {
  const graph = [
    { id: 'plan', needs: [] }, { id: 'old', parent: 'plan', needs: [] },
    { id: 'same', parent: 'plan', needs: [] }, { id: 'sibling', parent: 'plan', needs: [] },
    { id: 'downstream', needs: ['old'] }, { id: 'after', needs: ['plan'] }, { id: 'artifact-only', needs: [] },
  ]
  const state: RunState = { runId: 'test', requirementId: 'req', workflowId: 'test', workflowVersion: '1', status: 'succeeded', startedAt: '', args: {}, expansions: [],
    nodes: Object.fromEntries(graph.map(({ id }) => [id, { id, status: 'succeeded', attempts: 1, outputs: [], inputs:
      id === 'old' || id === 'same' ? [{ workspace: 'req', path: 'spec.md', version: id === 'old' ? 1 : 2 }] :
        id === 'artifact-only' ? [{ workspace: 'req', path: 'output.md', version: 1 }] : [] }])),
  }
  state.nodes.old!.outputs = [{ workspace: 'req', path: 'output.md', version: 1 }]
  const before = structuredClone(state)
  expect(new Set(propagateStale(state, graph, { workspace: 'req', path: 'spec.md', version: 2 }))).toEqual(new Set(['old', 'plan', 'downstream', 'after']))
  expect(propagateStale(state, graph, { workspace: 'other', path: 'spec.md' })).toEqual([])
  expect(propagateStale(state, graph, { workspace: 'req', path: 'spec.md' })).toContain('same')
  expect(state).toEqual(before)
})

it('指定版本只匹配未知或更旧的输入；迟到通知不能把更新输入当种子', () => {
  const state: RunState = { runId: 'test', requirementId: 'req', workflowId: 'test', workflowVersion: '1', status: 'succeeded', startedAt: '', args: {}, expansions: [],
    nodes: Object.fromEntries([undefined, 1, 2, 3].map((version, index) => [String(index), {
      id: String(index), status: 'succeeded', attempts: 1, outputs: [], inputs: [{ workspace: 'req', path: 'spec', version }],
    }])),
  }
  const graph = Object.keys(state.nodes).map((id) => ({ id, needs: [] }))
  expect(propagateStale(state, graph, { workspace: 'req', path: 'spec', version: 2 })).toEqual(['0', '1'])
  expect(propagateStale(state, graph, { workspace: 'req', path: 'spec' })).toEqual(['0', '1', '2', '3'])
})
