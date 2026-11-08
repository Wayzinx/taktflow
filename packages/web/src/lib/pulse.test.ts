import { describe, expect, it } from 'vitest'
import type { ProjectOverview, RequirementSummary } from '@taktflow/core'
import { diffPulse, pulseIcon, pulseSnap, pulseTitle } from './pulse'

const req = (id: string, over: Partial<RequirementSummary> = {}): RequirementSummary =>
  ({ id, title: `需求 ${id}`, status: 'active', stages: [], pendingAttention: 0, usage: { inputTokens: 0, outputTokens: 0 }, latestRunId: 'r1', ...over }) as RequirementSummary
const overview = (requirements: RequirementSummary[], asks: Array<[string, string]> = []): ProjectOverview =>
  ({ name: 'p', requirements, attention: asks.map(([requestId, requirementId]) => ({ requestId, requirementId, ask: '要不要继续？' })), totals: {} }) as unknown as ProjectOverview

describe('脉搏', () => {
  it('同一次运行从在跑变成结束 → 运行结束，结果取最近运行的状态', () => {
    const before = pulseSnap(overview([req('REQ-1', { current: { runId: 'r1', nodeId: 'dev', title: '实现', status: 'running' } })]))
    const after = pulseSnap(overview([req('REQ-1', { status: 'delivered', recentRuns: [{ runId: 'r1', status: 'succeeded', startedAt: '', tokens: 1 }] })]))
    expect(before.sig).not.toBe(after.sig)
    expect(diffPulse(before, after)).toEqual([{ type: 'run-ended', requirementId: 'REQ-1', title: '需求 REQ-1', runId: 'r1', outcome: 'succeeded' }])
  })

  it('换了一次新运行、或一直没在跑，都不算结束；新待办只提示新出现的', () => {
    const live = { current: { runId: 'r1', nodeId: 'dev', title: '实现', status: 'running' as const } }
    const before = pulseSnap(overview([req('REQ-1', live), req('REQ-2')], [['a1', 'REQ-2']]))
    const after = pulseSnap(overview([req('REQ-1', { latestRunId: 'r2' }), req('REQ-2')], [['a1', 'REQ-2'], ['a2', 'REQ-2']]))
    expect(diffPulse(before, after)).toEqual([{ type: 'waiting', requirementId: 'REQ-2', title: '需求 REQ-2', requestId: 'a2', ask: '要不要继续？' }])
    expect(after.waiting).toBe(2)
  })

  it('没变化时签名相同', () => {
    const o = overview([req('REQ-1')], [['a1', 'REQ-1']])
    expect(pulseSnap(o).sig).toBe(pulseSnap(o).sig)
  })

  it('标题与图标', () => {
    expect(pulseTitle(0)).toBe('taktflow 控制台')
    expect(pulseTitle(3)).toBe('(3) taktflow 控制台')
    expect(pulseIcon('idle')).not.toContain('circle')
    expect(decodeURIComponent(pulseIcon('waiting'))).toContain("<circle cx='22.5'")
  })
})
