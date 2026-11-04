import { describe, expect, it } from 'vitest'
import type { RunState, WorkflowSnapshot } from '../types.js'
import { deriveRequirementState } from './requirement.js'

const snapshot: WorkflowSnapshot = { id: 'w', title: 'W', version: '1', stages: [{ id: 'quality', title: '质量' }], nodes: [
  { id: 'report', kind: 'script', title: '报告', needs: [], stage: 'quality' },
  { id: 'accept', kind: 'human', title: '准出', ask: '批准？', needs: ['report'], stage: 'quality' },
] }
const state = (): RunState => ({ runId: 'r', workflowId: 'w', workflowVersion: '1', requirementId: 'REQ-1', startedAt: '', status: 'succeeded', args: {}, expansions: [], nodes: {
  report: { id: 'report', status: 'succeeded', attempts: 1, outputs: [] },
  accept: { id: 'accept', status: 'succeeded', attempts: 1, outputs: [], result: { decision: 'approve' } },
} })

describe('deriveRequirementState', () => {
  it('最终阶段批准且完成才能交付', () => {
    expect(deriveRequirementState(snapshot, state())).toEqual({ status: 'delivered', stage: 'quality' })
  })
  it.each(['waiting_human', 'running', 'failed', 'cancelled'] as const)('运行 %s 优先于阶段完成', (status) => {
    const run = state(); run.status = status
    expect(deriveRequirementState(snapshot, run).status).toBe(['failed', 'cancelled'].includes(status) ? 'blocked' : 'active')
  })
  it.each(['skipped', 'pending', 'blocked'] as const)('最终人工节点 %s 不交付', (status) => {
    const run = state(); run.nodes.accept!.status = status
    expect(deriveRequirementState(snapshot, run).status).toBe(status === 'blocked' ? 'blocked' : 'active')
  })
  it.each([undefined, {}, { decision: 'reject' }, { decision: 'choice' }, { answer: ' ' }])('缺少有效回答 %j 不交付', (result) => {
    const run = state(); run.nodes.accept!.result = result
    expect(deriveRequirementState(snapshot, run).status).toBe('active')
  })
  it.each([{ answer: '确认需求' }, { decision: 'choice', answer: 'A' }])('允许具有实际结果的问答表单 %j', (result) => {
    const run = state(); run.nodes.accept!.result = result
    expect(deriveRequirementState(snapshot, run).status).toBe('delivered')
  })
  it('空阶段、无阶段、全跳过、前置未完成都不交付', () => {
    const run = state()
    expect(deriveRequirementState({ ...snapshot, stages: [] }, run).status).toBe('active')
    expect(deriveRequirementState({ ...snapshot, stages: [...snapshot.stages, { id: 'empty', title: '空' }] }, run).status).toBe('active')
    Object.values(run.nodes).forEach((node) => { node.status = 'skipped' })
    expect(deriveRequirementState(snapshot, run).status).toBe('active')
    run.nodes.report!.status = 'pending'
    expect(deriveRequirementState(snapshot, run).stage).toBe('quality')
  })
})
