import type { CSSProperties } from 'react'
import { Gavel } from 'lucide-react'
import type { ReviewIssue, ReviewRecord } from '@taktflow/core'
import { StatusBadge } from '../../../components/ui'
import { SEVERITY, SEVERITY_ORDER, VERDICT_META, toneColor, toneSoft } from './review-meta'

/** 每个评审者一张卡：结论、分数条、摘要、问题数。裁决者的记录单独标出（只在结论冲突时出现）。 */
export function ReviewerCards({ records, threshold }: { records: ReviewRecord[]; threshold?: number }) {
  return (
    <div className="rv-reviewers">
      {records.map((r) => {
        const v = VERDICT_META[r.verdict]
        return (
          <div key={`${r.reviewer}${r.arbiter ? ':arbiter' : ''}`} className={`rv-reviewer v-${r.verdict}${r.arbiter ? ' arbiter' : ''}`}>
            <div className="rv-reviewer-head">
              {r.arbiter && (
                <span className="rv-arbiter" title="评审者结论冲突时由裁决者决定本轮是否通过">
                  <Gavel />
                  裁决
                </span>
              )}
              <span className="mono rv-reviewer-name">{r.reviewer}</span>
              <span style={{ flex: 1 }} />
              <StatusBadge meta={v} subtle />
            </div>
            {r.score !== undefined && <ScoreBar score={r.score} tone={v.tone} threshold={threshold} />}
            <p className="rv-reviewer-summary">{r.summary}</p>
            {r.issues.length > 0 && (
              <div className="rv-reviewer-foot">
                {SEVERITY_ORDER.map((s) => {
                  const n = r.issues.filter((i) => i.severity === s).length
                  return n ? <SeverityTag key={s} severity={s} count={n} /> : null
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 分数条：填充用 transform: scaleX（动效规范：不动画 width）。 */
function ScoreBar({ score, tone, threshold }: { score: number; tone: Parameters<typeof toneColor>[0]; threshold?: number }) {
  const v = Math.max(0, Math.min(100, score))
  return (
    <div className="rv-score" style={{ '--tone': toneColor(tone) } as CSSProperties}>
      <span className="rv-score-num num">{score}</span>
      <span className="rv-score-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label="评分">
        <span className="rv-score-fill" style={{ transform: `scaleX(${v / 100})` }} />
        {threshold !== undefined && <span className="rv-score-threshold" style={{ left: `${threshold}%` }} title={`通过线 ${threshold}`} />}
      </span>
    </div>
  )
}

export function SeverityTag({ severity, count }: { severity: ReviewIssue['severity']; count?: number }) {
  const s = SEVERITY[severity]
  return (
    <span className={`rv-sev sev-${severity}`} style={{ '--tone': toneColor(s.tone), '--tone-soft': toneSoft(s.tone) } as CSSProperties}>
      {s.label}
      {count !== undefined && <span className="num"> {count}</span>}
    </span>
  )
}
