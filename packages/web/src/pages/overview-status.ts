import type { ProjectOverview, RequirementSummary, Risk } from '@taktflow/core'

/**
 * 总览上几个数字的口径（页头、读数格、等你决定共用一份）：风险数 = 空间全部未处理风险（与 /api/spaces 的 risks 同口径，
 * 含不挂需求的空间级风险）；阻塞数 = totals.blocked（与空间卡片同口径）。
 */
export interface RiskGroups {
  /** 挂在需求上的风险，按需求分组，组内高风险在前。 */
  byRequirement: Map<string, Risk[]>
  /** 与需求无关的空间级风险（如成绩单疑似退化）。 */
  space: Risk[]
  /** 全部未处理风险，高风险在前。 */
  all: Risk[]
}

const byLevel = (a: Risk, b: Risk) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1)

export function groupRisks(risks: Risk[]): RiskGroups {
  const all = [...risks].sort(byLevel)
  const byRequirement = new Map<string, Risk[]>()
  for (const r of all) if (r.requirementId) byRequirement.set(r.requirementId, [...(byRequirement.get(r.requirementId) ?? []), r])
  return { byRequirement, space: all.filter((r) => !r.requirementId), all }
}

/** 阻塞了却没有待办：没有人被叫来处理，要在"等你决定"里点名。 */
export const isStuck = (r: RequirementSummary) => r.status === 'blocked' && !r.pendingAttention

const DAY = 86_400_000

/** 最近一次运行（含 Lead 任务运行）是 24 小时内的失败。 */
export function failedLately(r: RequirementSummary, now = Date.now()): boolean {
  const last = r.recentRuns?.at(-1)
  return last?.status === 'failed' && now - Date.parse(last.startedAt) < DAY
}

/**
 * 页头一句话：只说需要注意的（数字已经在读数里）。待办、阻塞、最近失败、风险都没有，且风险已经拿到，才说"一切顺利"；
 * 风险还没拿到时返回 undefined，页头先放骨架。最近失败只算还没被记成阻塞的（例如失败的是 Lead 任务运行）。
 */
export function describeOverview(p: ProjectOverview, risks: { all: Risk[]; loading: boolean; failed: boolean }, workflows: number | undefined, now = Date.now()): string | undefined {
  const parts: string[] = []
  if (workflows === 0) parts.push('还没有流水线')
  if (!p.requirements.length) parts.push('还没有需求')
  if (p.attention.length) parts.push(`${p.attention.length} 项等你决定`)
  if (p.totals.blocked) parts.push(`${p.totals.blocked} 个需求阻塞`)
  const waiting = p.requirements.filter((r) => r.status !== 'blocked' && !r.pendingAttention && r.stages.some((s) => s.status === 'waiting_human')).length
  if (waiting) parts.push(`${waiting} 个需求等人处理`)
  const cancelled = p.requirements.filter((r) => r.recentRuns?.some((run) => run.runId === r.latestRunId && run.status === 'cancelled')).length
  if (cancelled) parts.push(`${cancelled} 个需求运行已取消，可重新启动`)
  const failed = p.requirements.filter((r) => r.status !== 'blocked' && failedLately(r, now)).length
  if (failed) parts.push(`${failed} 个需求最近一次运行失败`)
  if (risks.all.length) parts.push(`${risks.all.length} 条风险`)
  else if (risks.failed) parts.push('风险暂时读不到')
  if (parts.length) return parts.join(' · ')
  return risks.loading || workflows === undefined ? undefined : '一切顺利'
}
