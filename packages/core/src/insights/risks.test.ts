import { describe, expect, it } from 'vitest'
import type { RunState, EventEnvelope, EventPayloads, EventType } from '../types.js'
import { computeRiskSnapshot, type RiskSnapshot } from './risks.js'
const now = new Date('2026-11-06T12:00:00Z')
const run: RunState = { runId: 'run-1', workflowId: 'flow', workflowVersion: '1', requirementId: 'REQ-001', status: 'running', startedAt: '2026-11-06T11:00:00Z', nodes: {}, args: {}, expansions: [], budget: { tokens: 100 } }
const event = <T extends EventType>(type: T, data: EventPayloads[T], nodeId = 'test'): EventEnvelope<T> => ({ type, data, nodeId, runId: 'run-1', seq: 1, ts: '2026-11-06T11:59:00Z', actor: { type: 'system', id: 'test' }, hash: '', prevHash: '' })
const base = (): RiskSnapshot => ({ requirements: [], runs: [], attention: [] })
describe('确定性风险规则', () => {
  it.each([[4, undefined], [4.1, 'medium'], [24, 'medium'], [24.1, 'high']] as const)('待办 %s 小时', (hours, level) => {
    const snapshot = base(); snapshot.attention.push({ requestId: 'a', runId: 'run-1', nodeId: 'human', requirementId: 'REQ-001', ask: '确认', form: 'approve', createdAt: new Date(now.getTime() - hours * 3600000).toISOString() })
    expect(computeRiskSnapshot(snapshot, 'shop', now)[0]?.level).toBe(level)
  })
  it.each([[79, undefined], [80, 'medium'], [100, 'high']] as const)('预算 %s%%', (tokens, level) => {
    const snapshot = base(); snapshot.runs.push({ run, events: [event('harness.usage', { inputTokens: tokens, outputTokens: 0 })] })
    expect(computeRiskSnapshot(snapshot, 'shop', now).find((risk) => risk.kind === 'budget')?.level).toBe(level)
  })
  it('15 分钟阈值、暂停不算停滞、返回不带 state', () => {
    const snapshot = base(); snapshot.runs.push({ run: { ...run, startedAt: '2026-11-06T11:45:00Z' }, events: [] })
    expect(computeRiskSnapshot(snapshot, 'shop', now)).toHaveLength(0)
    snapshot.runs[0]!.run.startedAt = '2026-11-06T11:44:59Z'
    const risk = computeRiskSnapshot(snapshot, 'shop', now)[0]!
    expect(risk).toMatchObject({ kind: 'stalled', level: 'high', evidence: [{ href: '/s/shop/run/run-1', label: expect.any(String) }] }); expect(risk).not.toHaveProperty('state')
    snapshot.runs[0]!.run.status = 'waiting_human'; expect(computeRiskSnapshot(snapshot, 'shop', now)).toHaveLength(0)
  })
  it('失败指纹、评审早停、校验失败、截止、缺陷和退化', () => {
    const snapshot = base()
    snapshot.runs.push({ run, events: [event('retry.suppressed', { fingerprint: 'f', code: 'error', count: 2, reason: '重复' }), event('review.exhausted', { rounds: 2, action: 'human', reason: 'no_progress' }), event('gate.result', { pass: false, checks: [] })] })
    snapshot.requirements.push({ id: 'REQ-001', title: '截止', status: 'active', links: [], createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', dueAt: '2026-11-06T13:00:00Z' })
    snapshot.defects = [{ id: 'D-1', title: '缺陷', requirementId: 'REQ-001' }]
    snapshot.scorecards = [{ key: { by: 'node', nodeId: 'test' }, label: '测试', regression: { suspected: true } } as never]
    const risks = computeRiskSnapshot(snapshot, 'shop', now)
    expect(risks.map((r) => r.kind).sort()).toEqual(['repeat-failure', 'review-stuck', 'gate-failed', 'deadline', 'defect-escape', 'regression'].sort())
    expect(risks.every((r) => r.key.startsWith(`${r.kind}:shop/`))).toBe(true)
  })
  it('几十万条事件的长运行不爆栈', () => {
    const snapshot = base()
    const many = Array.from({ length: 300_000 }, () => event('harness.message', { role: 'system', text: '' }))
    snapshot.runs.push({ run: { ...run, status: 'waiting_human' }, events: many })
    expect(() => computeRiskSnapshot(snapshot, 'shop', now)).not.toThrow()
  })
  it('完成的节点不继续报历史失败，已交付需求不报截止', () => {
    const snapshot = base(); snapshot.runs.push({ run: { ...run, status: 'succeeded' }, events: [event('gate.result', { pass: false, checks: [] })] })
    snapshot.requirements.push({ id: 'REQ-001', title: '完成', status: 'delivered', links: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', dueAt: '2026-01-02' })
    expect(computeRiskSnapshot(snapshot, 'shop', now)).toEqual([])
  })
})
