import type { CSSProperties } from 'react'
import { CornerDownRight, Lightbulb, MapPin } from 'lucide-react'
import type { ReviewIssue, ReviewRecord, ReviewResponse, ReviewRound } from '@taktflow/core'
import { StatusBadge } from '../../../components/ui'
import { RESPONSE, SEVERITY, SEVERITY_ORDER, VERDICT_META, toneColor, toneSoft } from './review-meta'

/** 每个评审者一张卡：结论、分数条、摘要、问题数。 */
export function ReviewerCards({ records, threshold }: { records: ReviewRecord[]; threshold?: number }) {
  return (
    <div className="rv-reviewers">
      {records.map((r) => {
        const v = VERDICT_META[r.verdict]
        return (
          <div key={r.reviewer} className={`rv-reviewer v-${r.verdict}`}>
            <div className="rv-reviewer-head">
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

function ScoreBar({ score, tone, threshold }: { score: number; tone: Parameters<typeof toneColor>[0]; threshold?: number }) {
  const v = Math.max(0, Math.min(100, score))
  return (
    <div className="rv-score" style={{ '--tone': toneColor(tone) } as CSSProperties}>
      <span className="rv-score-num num">{score}</span>
      <span className="rv-score-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label="评分">
        <span className="rv-score-fill" style={{ width: `${v}%` }} />
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

/** 问题清单：按严重程度排序，每条带作者回应（已修 / 不采纳 / 延后）。 */
export function IssueList({ round, isLast, exhausted }: { round: ReviewRound; isLast: boolean; exhausted: boolean }) {
  const items = round.records
    .flatMap((r) => r.issues.map((i) => ({ issue: i, reviewer: r.reviewer, response: round.responses.find((x) => x.issueId === i.id) })))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.issue.severity) - SEVERITY_ORDER.indexOf(b.issue.severity))
  if (!items.length) return <p className="rv-empty">本轮没有提出问题。</p>
  // 通过的轮次不要求回应；最后一轮未通过且轮次用完时，问题随打回一起交给上游
  const pendingHint = round.passed ? '本轮已通过，不要求回应' : isLast && !exhausted ? '等待作者回应' : '随打回交给上游重做'
  return (
    <ul className="rv-issues">
      {items.map(({ issue, reviewer, response }) => (
        <li key={issue.id} className={`rv-issue sev-${issue.severity}`}>
          <div className="rv-issue-head">
            <SeverityTag severity={issue.severity} />
            <span className="mono rv-issue-id">{issue.id}</span>
            {issue.location && (
              <span className="rv-issue-loc mono truncate" title={issue.location}>
                <MapPin />
                {issue.location}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <span className="mono faint">{reviewer}</span>
          </div>
          <p className="rv-issue-desc">{issue.description}</p>
          {issue.suggestion && (
            <p className="rv-issue-sugg">
              <Lightbulb />
              <span>{issue.suggestion}</span>
            </p>
          )}
          <ResponseRow response={response} hint={pendingHint} />
        </li>
      ))}
    </ul>
  )
}

function ResponseRow({ response, hint }: { response?: ReviewResponse; hint: string }) {
  if (!response) return <div className="rv-response none"><CornerDownRight /><span className="faint">{hint}</span></div>
  const meta = RESPONSE[response.action]
  return (
    <div className="rv-response">
      <CornerDownRight />
      <span className="rv-response-label">作者回应</span>
      <StatusBadge meta={meta} subtle />
      <span className="rv-response-note">{response.note}</span>
    </div>
  )
}
