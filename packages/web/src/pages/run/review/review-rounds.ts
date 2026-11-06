import type { ReviewRound } from '@taktflow/core'

/** 一轮评审的展示视图：修订（打回一次 +1）、修订内轮次、全局 seq（跨修订不重置，作选中键）。 */
export interface RoundView {
  r: ReviewRound
  revision: number
  round: number
  seq: number
}

export interface RevisionView {
  revision: number
  rounds: RoundView[]
}

/**
 * 统一轮次编号。新协议直接带 revision / seq；旧数据没有时按"轮次号回落 = 打回"推断：
 * server 打回后轮次号从 1 重数（1,2,3,1…），旧 mock 用全局递增（1..6），按 maxRounds 切修订。
 */
export function roundViews(rounds: ReviewRound[], maxRounds: number): RoundView[] {
  if (rounds.every((r) => r.revision !== undefined)) return rounds.map((r, i) => ({ r, revision: r.revision!, round: r.round, seq: r.seq ?? i + 1 }))
  let revision = 1
  let prev = 0
  return rounds.map((r, i) => {
    let round = r.round
    if (round <= prev) revision++
    else if (round > maxRounds) {
      revision = Math.floor((round - 1) / maxRounds) + 1
      round = ((round - 1) % maxRounds) + 1
    }
    prev = r.round
    return { r, revision, round, seq: r.seq ?? i + 1 }
  })
}

export function revisionsOf(views: RoundView[]): RevisionView[] {
  const out: RevisionView[] = []
  for (const v of views) {
    const last = out[out.length - 1]
    if (last && last.revision === v.revision) last.rounds.push(v)
    else out.push({ revision: v.revision, rounds: [v] })
  }
  return out
}

export function avgScore(r: ReviewRound): number | undefined {
  const s = r.records.map((x) => x.score).filter((x): x is number => x !== undefined)
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : undefined
}

export const issueCount = (r: ReviewRound) => r.records.reduce((n, x) => n + x.issues.length, 0)
