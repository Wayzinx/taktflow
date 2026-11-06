import { describe, expect, it, vi } from 'vitest'
import type { WorkflowDefinition } from '../types.js'
import { snapshotWorkflow } from './snapshot.js'

describe('snapshotWorkflow', () => {
  it('keeps protocol data for all node kinds, recurses loops, and never executes callbacks', () => {
    const callback = vi.fn()
    const def: WorkflowDefinition = {
      id: 'flow', title: 'Flow', description: 'description', version: '1',
      stages: [{ id: 'build', title: 'Build' }],
      nodes: [
        { id: 'script', kind: 'script', title: 'Script', run: callback, when: callback },
        { id: 'agent', kind: 'agent', title: 'Agent', stage: 'build', role: 'dev',
          prompt: 'static', needs: ['script'], harness: { harness: 'codex', model: 'model' },
          inputs: [{ path: 'spec/**' }],
          outputs: [{ path: 'out.json', kind: 'other', schema: {
            type: 'object', validate: callback,
            properties: { field: { type: 'string', validate: callback } },
            allOf: [{ check: callback, type: 'object' }, callback],
          } }],
        },
        { id: 'loop', kind: 'loop', title: 'Loop', until: callback, maxIterations: 3, body: [
          { id: 'inner', kind: 'loop', title: 'Inner', until: callback, maxIterations: 2, body: [
            { id: 'dynamic', kind: 'agent', title: 'Dynamic', role: 'dev', prompt: callback },
          ] },
        ] },
        { id: 'gate', kind: 'gate', title: 'Gate', checks: [
          { id: 'cmd', kind: 'command', title: 'Command', run: 'exit 0' },
          { id: 'fn', kind: 'function', fn: callback },
          { id: 'rubric', kind: 'rubric', role: 'reviewer', rubric: 'Review', threshold: 80 },
        ] },
        { id: 'judge', kind: 'judge', title: 'Judge', role: 'judge', target: 'script',
          routes: { product_bug: 'agent', unknown: 'human' }, harness: { harness: 'claude-code' } },
        { id: 'plan', kind: 'planner', title: 'Plan', role: 'planner', prompt: 'plan tasks',
          expand: callback, maxItems: 4, allowedRoles: ['dev'], harness: { harness: 'codex' } },
        { id: 'human', kind: 'human', title: 'Human', ask: 'Approve?', form: 'approve' },
        { id: 'subflow', kind: 'subflow', title: 'Subflow', workflow: {
          id: 'child', title: 'Child', version: '1', stages: [], nodes: [],
        } },
      ],
    }
    const snapshot = snapshotWorkflow(def)
    expect(snapshot.nodes[0]).toEqual({ id: 'script', kind: 'script', title: 'Script', needs: [] })
    expect(snapshot.nodes[1]).toMatchObject({ prompt: 'static', harness: 'codex', needs: ['script'],
      outputs: [{ schema: { type: 'object', properties: { field: { type: 'string' } },
        allOf: [{ type: 'object' }, null] } }],
    })
    expect(snapshot.nodes[2]?.body?.[0]?.body?.[0]?.prompt).toBeUndefined()
    expect(snapshot.nodes[2]?.body?.[0]?.maxIterations).toBe(2)
    expect(snapshot.nodes[3]?.checks).toEqual([
      { id: 'cmd', kind: 'command', title: 'Command' }, { id: 'fn', kind: 'function' },
      { id: 'rubric', kind: 'rubric', threshold: 80, role: 'reviewer' },
    ])
    expect(snapshot.nodes[4]).toMatchObject({ role: 'judge', target: 'script', harness: 'claude-code',
      routes: { product_bug: 'agent', unknown: 'human' } })
    expect(snapshot.nodes[5]).toMatchObject({ prompt: 'plan tasks', role: 'planner', maxItems: 4, allowedRoles: ['dev'] })
    expect(snapshot.nodes[6]).toMatchObject({ ask: 'Approve?', form: 'approve' })
    expect(snapshot.nodes[6]?.choices).toBeUndefined()
    expect(snapshot.nodes[7]).toEqual({ id: 'subflow', kind: 'subflow', title: 'Subflow', needs: [] })
    const check = (value: unknown): void => {
      expect(typeof value).not.toBe('function')
      if (value && typeof value === 'object') Object.values(value).forEach(check)
    }
    check(snapshot)
    expect(callback).not.toHaveBeenCalled()
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    expect(snapshot.stages).not.toBe(def.stages)
    snapshot.stages[0]!.title = 'Changed'
    snapshot.nodes[1]!.needs.push('new')
    snapshot.nodes[1]!.outputs![0]!.schema!.type = 'array'
    expect(def.stages[0]!.title).toBe('Build')
    expect(def.nodes[1]!.needs).toEqual(['script'])
    expect(def.nodes[1]!.outputs![0]!.schema!.type).toBe('object')
    expect(def.nodes[1]!.outputs![0]!.schema!.validate).toBe(callback)
  })

  it('omits a dynamic planner prompt', () => {
    const snapshot = snapshotWorkflow({ id: 'f', title: 'F', version: '1', stages: [], nodes: [
      { id: 'p', kind: 'planner', title: 'P', role: 'planner', prompt: () => 'dynamic',
        expand: () => [], maxItems: 1 },
    ] })
    expect(snapshot.nodes[0]?.prompt).toBeUndefined()
  })
})
