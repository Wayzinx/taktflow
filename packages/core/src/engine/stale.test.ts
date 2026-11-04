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

it('Expansion.nodes 优先于旧临时图，顶层依赖全限定、loop body 相对 ID，传播到 planner 与下游', () => {
  const ids = ['plan', 'plan/a/l', 'plan/a/l/read', 'plan/a/l/after', 'plan/b/task', 'plan/c/sibling', 'after']
  const state: RunState = { runId: 'run', requirementId: 'req', workflowId: 'flow', workflowVersion: '1', status: 'succeeded', startedAt: '', args: {},
    nodes: Object.fromEntries(ids.map((id) => [id, { id, status: 'succeeded', attempts: 1, outputs: [], inputs: id.endsWith('/read') ? [{ workspace: 'req', path: 'spec', version: 1 }] : [] }])),
    expansions: [{ plannerId: 'plan', at: '', items: [], nodeIds: ['plan/a/l', 'plan/b/task', 'plan/c/sibling'], nodes: [
      { id: 'plan/a/l', kind: 'loop', title: '', needs: [], body: [
        { id: 'read', kind: 'script', title: '', needs: [] }, { id: 'after', kind: 'script', title: '', needs: ['read'] },
      ] },
      { id: 'plan/b/task', kind: 'script', title: '', needs: ['plan/a/l'] },
      { id: 'plan/c/sibling', kind: 'script', title: '', needs: [] },
    ] }],
  }
  const old = [{ id: 'plan', needs: [] }, { id: 'after', needs: ['plan'] }, { id: 'plan/b/task', needs: ['plan/c/sibling'] }]
  expect(new Set(propagateStale(state, old, { workspace: 'req', path: 'spec', version: 2 }))).toEqual(new Set(['plan/a/l/read', 'plan/a/l/after', 'plan/a/l', 'plan/b/task', 'plan', 'after']))
})
