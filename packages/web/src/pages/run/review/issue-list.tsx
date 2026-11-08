import { useState } from 'react'
import { ChevronRight, CornerDownRight, EyeOff, Lightbulb, MapPin } from 'lucide-react'
import type { ReviewContinuity, ReviewDisposition, ReviewIssue, ReviewIssueEntry, ReviewRecord, ReviewResponse } from '@taktflow/core'
import { StatusBadge } from '../../../components/ui'
import { OBSERVATION, RESPONSE, SEVERITY_ORDER, type ObservationKey } from './review-meta'
import type { RoundView } from './review-rounds'
import { Tag } from './facet-tags'
import { DisposeActions, DispositionNote, effectiveDisposition } from './issue-dispose'
import { SeverityTag } from './round-detail'
import { IssueKey, IssueStatusTag } from './issue-ledger'

interface Item {
  issue: ReviewIssue
  reviewer: string
  response?: ReviewResponse
  continuity?: ReviewContinuity
}

function observationOf(c: ReviewContinuity | undefined, first: boolean): ObservationKey | undefined {
  if (!c) return first ? undefined : 'new'
  return c.regressed ? 'regressed' : c.observation
}

/**
 * 问题清单：按严重程度排序；每条带系统观察（新增 / 重复 / 有变化 / 回潮）、作者回应、人工处置。
 * 上一轮提过、本轮没再提的问题收在"本轮未提及"里——系统不会因为没再提就当作已解决。
 * 只有最新一轮可以处置（处置按 groupKey 作用于这一类问题）。
 */
export function IssueList({ view, prev, isLast, exhausted, dispositions, runId, nodeId, ledger, onKey }: {
  view: RoundView
  prev?: RoundView
  isLast: boolean
  exhausted: boolean
  dispositions?: ReviewDisposition[]
  runId: string
  nodeId: string
  /** 问题台账（docs/design/21 §3）：有则显示问题键与 claimed / verified 状态。 */
  ledger?: ReviewIssueEntry[]
  onKey?: (key: string) => void
}) {
  const round = view.r
  const items: Item[] = round.records
    .flatMap((r) => r.issues.map((i) => ({ issue: i, reviewer: r.reviewer, response: round.responses.find((x) => x.issueId === i.id), continuity: round.continuity?.find((c) => c.issueId === i.id) })))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.issue.severity) - SEVERITY_ORDER.indexOf(b.issue.severity))
  const prevIssues = prev?.r.records.flatMap((r) => r.issues.map((i) => ({ issue: i, reviewer: r.reviewer }))) ?? []
  const missing = (round.continuity ?? [])
    .filter((c) => c.observation === 'not_observed')
    .map((c) => prevIssues.find((p) => p.issue.id === c.prevIssueId || p.issue.groupKey === c.groupKey))
    .filter((x): x is { issue: ReviewIssue; reviewer: string } => Boolean(x))
  const pendingHint = round.passed ? '本轮已同意，不要求回应' : isLast && !exhausted ? '等待作者回应' : '随打回交给上游重做'
  const first = !round.continuity

  return (
    <>
      {items.length ? (
        <ul className="rv-issues">
          {items.map((it) => (
            <IssueRow key={it.issue.id} item={it} obs={observationOf(it.continuity, first)} hint={pendingHint} canDispose={isLast} dispositions={dispositions} runId={runId} nodeId={nodeId} entry={ledger?.find((e) => e.key === it.issue.key)} onKey={onKey} />
          ))}
        </ul>
      ) : (
        <p className="rv-empty">本轮没有提出问题。</p>
      )}
      {missing.length > 0 && <NotObserved items={missing} dispositions={dispositions} canDispose={isLast} runId={runId} nodeId={nodeId} />}
      <PreviousChecks records={round.records} ledger={ledger} onKey={onKey} />
    </>
  )
}

function IssueRow({ item, obs, hint, canDispose, dispositions, runId, nodeId, entry, onKey }: { item: Item; obs?: ObservationKey; hint: string; canDispose: boolean; dispositions?: ReviewDisposition[]; runId: string; nodeId: string; entry?: ReviewIssueEntry; onKey?: (key: string) => void }) {
  const { issue, reviewer, response } = item
  const { current, expired } = effectiveDisposition(dispositions, issue.groupKey, issue.fingerprint)
  const closed = current && current.state !== 'open'
  return (
    <li className={`rv-issue sev-${issue.severity}${closed ? ' closed' : ''}`}>
      <div className="rv-issue-head">
        {issue.key && <IssueKey k={issue.key} onClick={onKey ? () => onKey(issue.key!) : undefined} />}
        <SeverityTag severity={issue.severity} />
        {obs && <ObservationTag k={obs} />}
        {issue.title && <span className="rv-issue-title truncate">{issue.title}</span>}
        {issue.location && (
          <span className="rv-issue-loc mono truncate" title={issue.location}>
            <MapPin />
            {issue.location}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="mono faint">{reviewer}</span>
        {entry ? <IssueStatusTag status={entry.status} /> : <span className="mono rv-issue-id">{issue.id}</span>}
      </div>
      <p className="rv-issue-desc">{issue.description}</p>
      {issue.suggestion && (
        <p className="rv-issue-sugg">
          <Lightbulb />
          <span>{issue.suggestion}</span>
        </p>
      )}
      <ResponseRow response={response} hint={hint} />
      {(current || expired) && <DispositionNote d={(current ?? expired)!} expired={Boolean(expired)} />}
      {canDispose && issue.groupKey && <DisposeActions runId={runId} nodeId={nodeId} groupKey={issue.groupKey} current={current?.state} />}
    </li>
  )
}

export function ObservationTag({ k }: { k: ObservationKey }) {
  const m = OBSERVATION[k]
  return (
    <Tag tone={m.tone} title={m.hint} className={`obs obs-${k}`}>
      {m.label}
    </Tag>
  )
}

function NotObserved({ items, dispositions, canDispose, runId, nodeId }: { items: Array<{ issue: ReviewIssue; reviewer: string }>; dispositions?: ReviewDisposition[]; canDispose: boolean; runId: string; nodeId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rv-missing">
      <button type="button" className="rv-missing-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={`rv-caret${open ? ' open' : ''}`} />
        <EyeOff />
        本轮未提及 <span className="num">{items.length}</span>
        <span className="faint">· 上一轮提过、本轮没再提；系统不会据此当作已解决，需要的话请人工处置</span>
      </button>
      {open && (
        <ul className="rv-issues rv-missing-list">
          {items.map(({ issue, reviewer }) => {
            const { current, expired } = effectiveDisposition(dispositions, issue.groupKey, issue.fingerprint)
            return (
              <li key={issue.id} className="rv-issue muted">
                <div className="rv-issue-head">
                  <SeverityTag severity={issue.severity} />
                  <ObservationTag k="not_observed" />
                  {issue.title && <span className="rv-issue-title truncate">{issue.title}</span>}
                  <span style={{ flex: 1 }} />
                  <span className="mono faint">{reviewer}</span>
                  <span className="mono rv-issue-id">{issue.id}</span>
                </div>
                <p className="rv-issue-desc">{issue.description}</p>
                {(current || expired) && <DispositionNote d={(current ?? expired)!} expired={Boolean(expired)} />}
                {canDispose && issue.groupKey && <DisposeActions runId={runId} nodeId={nodeId} groupKey={issue.groupKey} current={current?.state} />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
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

const PREV: Record<NonNullable<ReviewRecord['previous']>[number]['status'], string> = { resolved: '确认已修', still_open: '仍有问题', not_checked: '没给结论' }

/** 本轮评审者对上一轮"作者称已修"的问题逐键复查的结论。 */
function PreviousChecks({ records, ledger, onKey }: { records: ReviewRecord[]; ledger?: ReviewIssueEntry[]; onKey?: (key: string) => void }) {
  const rows = records.flatMap((r) => (r.previous ?? []).map((p) => ({ ...p, reviewer: r.reviewer })))
  if (!rows.length) return null
  return (
    <div className="rv-prev">
      <div className="rv-prev-title">逐键复查上一轮</div>
      <ul>
        {rows.map((p) => (
          <li key={`${p.reviewer}:${p.key}`} className={`rv-prev-row p-${p.status}`}>
            <IssueKey k={p.key} onClick={onKey ? () => onKey(p.key) : undefined} />
            <span className="truncate">{ledger?.find((e) => e.key === p.key)?.title}</span>
            <span style={{ flex: 1 }} />
            <span className="mono faint">{p.reviewer}</span>
            <b className="rv-prev-st">{PREV[p.status]}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}
