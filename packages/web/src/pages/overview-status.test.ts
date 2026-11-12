import { describe, expect, it } from 'vitest'
import type { ProjectOverview, RequirementSummary, Risk } from '@taktflow/core'
import { describeOverview, groupRisks, isStuck } from './overview-status'

const risk = (key: string, requirementId?: string, level: Risk['level'] = 'medium'): Risk => ({
  key, kind: requirementId ? 'defect-escape' : 'regression', level, spaceId: 's', ...(requirementId ? { requirementId } : {}),
  title: key, detail: '', evidence: [], firstSeenAt: '', lastSeenAt: '', actions: [], state: 'open',
})
const req = (id: string, patch: Partial<RequirementSummary> = {}): RequirementSummary => ({
  id, title: id, status: 'active', createdAt: '', updatedAt: '', stages: [], pendingAttention: 0, usage: { inputTokens: 0, outputTokens: 0 }, ...patch,
} as RequirementSummary)
const project = (requirements: RequirementSummary[], patch: Partial<ProjectOverview['totals']> = {}, attention = 0): ProjectOverview => ({
  name: 'p', requirements, attention: Array.from({ length: attention }, (_, i) => ({ requestId: `a${i}` })) as ProjectOverview['attention'],
  totals: { requirements: requirements.length, active: 0, delivered: 0, blocked: requirements.filter((r) => r.status === 'blocked').length, runs: 0, usage: { inputTokens: 0, outputTokens: 0 }, ...patch },
})
const loaded = (risks: Risk[]) => ({ ...groupRisks(risks), loading: false, failed: false })

describe('风险口径（TF-002）', () => {
  it('不挂需求的空间级风险也计数，总数与 /api/spaces 的 risks 一致', () => {
    const g = groupRisks([risk('defect', 'REQ-001'), risk('regression')])
    expect(g.all).toHaveLength(2)
    expect(g.space.map((r) => r.key)).toEqual(['regression'])
    expect([...g.byRequirement.keys()]).toEqual(['REQ-001'])
  })
  it('同一需求的风险高的在前', () => {
    expect(groupRisks([risk('m', 'REQ-1'), risk('h', 'REQ-1', 'high')]).byRequirement.get('REQ-1')!.map((r) => r.key)).toEqual(['h', 'm'])
  })
})

describe('页头一句话（TF-004 / TF-047）', () => {
  const now = Date.parse('2026-11-12T12:00:00Z')
  it('风险还没拿到时不说"一切顺利"', () => {
    expect(describeOverview(project([req('REQ-1')]), { ...groupRisks([]), loading: true, failed: false }, 1, now)).toBeUndefined()
    expect(describeOverview(project([req('REQ-1')]), { ...groupRisks([]), loading: false, failed: true }, 1, now)).toBe('风险暂时读不到')
    expect(describeOverview(project([req('REQ-1')]), loaded([]), undefined, now)).toBeUndefined()
  })
  it('有阻塞、空间级风险时都要说出来', () => {
    const p = project([req('REQ-3', { status: 'blocked' }), req('REQ-4', { status: 'blocked' })])
    expect(describeOverview(p, loaded([]), 1, now)).toBe('2 个需求阻塞')
    expect(describeOverview(project([req('REQ-1')]), loaded([risk('regression')]), 1, now)).toBe('1 条风险')
    expect(describeOverview(project([req('REQ-1')], {}, 1), loaded([risk('d', 'REQ-1'), risk('regression')]), 1, now)).toBe('1 项等你决定 · 2 条风险')
  })
  it('空空间、没有流水线、最近一次运行刚失败都不是"一切顺利"', () => {
    expect(describeOverview(project([]), loaded([]), 0, now)).toBe('还没有流水线 · 还没有需求')
    expect(describeOverview(project([]), loaded([]), 2, now)).toBe('还没有需求')
    expect(describeOverview(project([]), loaded([risk('regression')]), 2, now)).toBe('还没有需求 · 1 条风险')
    const failed = req('REQ-1', { recentRuns: [{ runId: 'r', status: 'failed', startedAt: '2026-11-12T11:00:00Z', tokens: 0, kind: 'task' }] })
    expect(describeOverview(project([failed]), loaded([]), 1, now)).toBe('1 个需求最近一次运行失败')
    const old = req('REQ-1', { recentRuns: [{ runId: 'r', status: 'failed', startedAt: '2026-11-10T11:00:00Z', tokens: 0 }] })
    expect(describeOverview(project([old]), loaded([]), 1, now)).toBe('一切顺利')
  })
  it('还有等人处理的阶段或取消后待重启的运行时不给顺利结论', () => {
    const waiting = req('REQ-1', { stages: [{ id: 'dev', title: '研发', status: 'waiting_human', total: 1, done: 0 }] as RequirementSummary['stages'] })
    expect(describeOverview(project([waiting]), loaded([]), 1, now)).toBe('1 个需求等人处理')
    const cancelled = req('REQ-2', { latestRunId: 'r', recentRuns: [{ runId: 'r', status: 'cancelled', startedAt: '2026-11-12T11:00:00Z', tokens: 0 }] })
    expect(describeOverview(project([cancelled]), loaded([]), 1, now)).toBe('1 个需求运行已取消，可重新启动')
  })
  it('阻塞且没有待办的需求要点名', () => {
    expect([req('a', { status: 'blocked' }), req('b', { status: 'blocked', pendingAttention: 1 }), req('c')].filter(isStuck).map((r) => r.id)).toEqual(['a'])
  })
})
