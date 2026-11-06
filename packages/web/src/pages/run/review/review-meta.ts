import { Ban, Check, CircleDashed, FilePen, Hourglass, LoaderCircle, PenLine, Undo2, X } from 'lucide-react'
import type { IssueObservation, NodeDetail, ReviewDisposition, ReviewFacets, ReviewIssue, ReviewResponse, ReviewStatus, ReviewVerdict } from '@taktflow/core'
import type { StatusMeta, Tone } from '../../../lib/status'

export type ReviewView = NonNullable<NodeDetail['review']>
export type ReviewConfig = ReviewView['config']

export const REVIEW_STATUS: Record<ReviewStatus, StatusMeta> = {
  pending: { label: '未开始', tone: 'pending', icon: CircleDashed },
  in_review: { label: '评审中', tone: 'running', icon: LoaderCircle, spin: true },
  revising: { label: '作者修改中', tone: 'running', icon: FilePen },
  passed: { label: '已结束', tone: 'success', icon: Check },
  exhausted: { label: '轮次用完', tone: 'failed', icon: Ban },
  reworked: { label: '已打回', tone: 'stale', icon: Undo2 },
}

export const VERDICT_META: Record<ReviewVerdict, StatusMeta> = {
  approve: { label: '同意', tone: 'success', icon: Check },
  request_changes: { label: '要求修改', tone: 'waiting', icon: PenLine },
  reject: { label: '否决', tone: 'failed', icon: X },
}

/** 严重程度：只有 blocker / major 用状态色，minor / nit 用中性色，避免满屏告警。 */
export const SEVERITY: Record<ReviewIssue['severity'], { label: string; tone: Tone | 'neutral' }> = {
  blocker: { label: '阻断', tone: 'failed' },
  major: { label: '重要', tone: 'waiting' },
  minor: { label: '次要', tone: 'neutral' },
  nit: { label: '措辞', tone: 'neutral' },
}
export const SEVERITY_ORDER: ReviewIssue['severity'][] = ['blocker', 'major', 'minor', 'nit']

export const RESPONSE: Record<ReviewResponse['action'], StatusMeta> = {
  fixed: { label: '已修', tone: 'success', icon: Check },
  declined: { label: '不采纳', tone: 'skipped', icon: Ban },
  deferred: { label: '延后', tone: 'stale', icon: Hourglass },
}

/** 三枚正交标签（docs/design/19 §4）：结论 · 覆盖 · 新鲜度。no_findings 显示"无问题"，不显示"通过"。 */
export const OUTCOME: Record<NonNullable<ReviewFacets['outcome']>, { label: string; tone: Tone | 'neutral' }> = {
  approved: { label: '同意', tone: 'success' },
  no_findings: { label: '无问题', tone: 'success' },
  changes_requested: { label: '要求修改', tone: 'waiting' },
  rejected: { label: '否决', tone: 'failed' },
  escalated: { label: '交人裁决', tone: 'waiting' },
}
export const COVERAGE: Record<ReviewFacets['coverage'], { label: string; tone: Tone | 'neutral'; hint: string }> = {
  full: { label: '覆盖完整', tone: 'neutral', hint: '所有评审者都给出了结论，评审目标都可读' },
  partial: { label: '覆盖不全', tone: 'waiting', hint: '有评审者没给出结论，或有目标读不到' },
}
export const FRESHNESS: Record<ReviewFacets['freshness'], { label: string; tone: Tone | 'neutral'; hint: string }> = {
  current: { label: '当前版本', tone: 'neutral', hint: '评审之后目标产物 / 代码没有再变' },
  stale: { label: '已过期', tone: 'stale', hint: '评审之后目标产物 / 代码又变了，历史结论保留但不再代表当前版本' },
  unknown: { label: '版本未知', tone: 'neutral', hint: '还没有评审记录，或记录里没有目标版本' },
}

/** 系统对问题的观察（与上一轮比较，只由引擎算）。"回潮" = 作者上轮回应已修，本轮又出现。 */
export type ObservationKey = IssueObservation | 'regressed'
export const OBSERVATION: Record<ObservationKey, { label: string; tone: Tone | 'neutral'; hint: string }> = {
  new: { label: '新增', tone: 'running', hint: '上一轮没有这个问题' },
  repeated: { label: '重复', tone: 'neutral', hint: '上一轮提过，描述与位置都没变' },
  changed: { label: '有变化', tone: 'waiting', hint: '上一轮提过，但位置、严重度或描述变了' },
  not_observed: { label: '本轮未提及', tone: 'neutral', hint: '上一轮提过，本轮评审者没有再提；不代表已解决' },
  regressed: { label: '回潮', tone: 'failed', hint: '作者上轮回应"已修"，本轮又出现' },
}

/** 人工处置（只能人显式设置，留痕）。 */
export const DISPOSITION: Record<ReviewDisposition['state'], { label: string; tone: Tone | 'neutral' }> = {
  open: { label: '待处理', tone: 'neutral' },
  resolved: { label: '已解决', tone: 'success' },
  dismissed: { label: '已驳回', tone: 'skipped' },
}

export const toneColor = (t: Tone | 'neutral') => (t === 'neutral' ? 'var(--text-2)' : t === 'pending' ? 'var(--text-3)' : `var(--st-${t})`)
export const toneSoft = (t: Tone | 'neutral') => (t === 'neutral' || t === 'pending' ? 'var(--surface-hover)' : `var(--st-${t}-soft)`)

export function passRule(p: ReviewConfig['pass']): string {
  if (p === 'all') return '全部同意'
  if (p === 'majority') return '多数同意'
  return `均分 ≥ ${p.minScore}`
}

export function exhaustedRule(o: ReviewConfig['onExhausted']): string {
  if (o === 'human') return '交人'
  if (o === 'fail') return '失败'
  return `打回 ${o.rework}（最多 ${o.maxReworks ?? 1} 次）`
}

export function targetText(t: ReviewConfig['target']): string {
  return Array.isArray(t) ? t.join(', ') : `仓库 ${t.code.repo} 的改动${t.code.base ? `（基于 ${t.code.base}）` : ''}`
}
