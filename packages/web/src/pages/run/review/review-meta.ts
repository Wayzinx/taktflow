import { Ban, Check, CircleDashed, FilePen, Hourglass, LoaderCircle, PenLine, Undo2, X } from 'lucide-react'
import type { NodeDetail, ReviewIssue, ReviewResponse, ReviewRound, ReviewStatus, ReviewVerdict } from '@taktflow/core'
import type { StatusMeta, Tone } from '../../../lib/status'

export type ReviewView = NonNullable<NodeDetail['review']>
export type ReviewConfig = ReviewView['config']

export const REVIEW_STATUS: Record<ReviewStatus, StatusMeta> = {
  pending: { label: '未开始', tone: 'pending', icon: CircleDashed },
  in_review: { label: '评审中', tone: 'running', icon: LoaderCircle, spin: true },
  revising: { label: '作者修改中', tone: 'running', icon: FilePen },
  passed: { label: '已通过', tone: 'success', icon: Check },
  exhausted: { label: '轮次用完', tone: 'failed', icon: Ban },
  reworked: { label: '已打回', tone: 'stale', icon: Undo2 },
}

export const VERDICT_META: Record<ReviewVerdict, StatusMeta> = {
  approve: { label: '通过', tone: 'success', icon: Check },
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

export const toneColor = (t: Tone | 'neutral') => (t === 'neutral' ? 'var(--text-2)' : t === 'pending' ? 'var(--text-3)' : `var(--st-${t})`)
export const toneSoft = (t: Tone | 'neutral') => (t === 'neutral' || t === 'pending' ? 'var(--surface-hover)' : `var(--st-${t}-soft)`)

export function passRule(p: ReviewConfig['pass']): string {
  if (p === 'all') return '全部通过'
  if (p === 'majority') return '多数通过'
  return `均分 ≥ ${p.minScore}`
}

export function exhaustedRule(o: ReviewConfig['onExhausted']): string {
  if (o === 'human') return '轮次用完交人'
  if (o === 'fail') return '轮次用完即失败'
  return `轮次用完打回 ${o.rework}（最多 ${o.maxReworks ?? 1} 次）`
}

export function targetText(t: ReviewConfig['target']): string {
  return Array.isArray(t) ? t.join(', ') : `仓库 ${t.code.repo} 的改动${t.code.base ? `（基于 ${t.code.base}）` : ''}`
}

/**
 * 把轮次号统一成全局连续编号。server 打回重做后轮次号重新从 1 数起（1,2,3,1…），
 * mock 用全局递增（1..6）；统一之后轮次号可以当唯一标识，周期 = floor((round-1)/maxRounds)。
 */
export function normalizeRounds(rounds: ReviewRound[], maxRounds: number): ReviewRound[] {
  let offset = 0
  let prev = 0
  return rounds.map((r) => {
    if (r.round + offset <= prev) offset = Math.ceil(prev / maxRounds) * maxRounds
    prev = r.round + offset
    return offset ? { ...r, round: prev } : r
  })
}

/** 一个评审周期：打回重做之后轮次重新从 1 数起（这里的轮次号已经是 normalizeRounds 之后的全局编号）。 */
export interface ReviewCycle {
  index: number
  rounds: ReviewRound[]
}

export function cyclesOf(rounds: ReviewRound[], maxRounds: number): ReviewCycle[] {
  const out: ReviewCycle[] = []
  for (const r of rounds) {
    const i = Math.floor((r.round - 1) / maxRounds)
    if (!out[i]) out[i] = { index: i, rounds: [] }
    out[i].rounds.push(r)
  }
  return out.filter(Boolean)
}

/** 周期内的轮次（1..maxRounds）。 */
export const localRound = (round: number, maxRounds: number) => ((round - 1) % maxRounds) + 1

export function avgScore(r: ReviewRound): number | undefined {
  const s = r.records.map((x) => x.score).filter((x): x is number => x !== undefined)
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : undefined
}

export const issueCount = (r: ReviewRound) => r.records.reduce((n, x) => n + x.issues.length, 0)

