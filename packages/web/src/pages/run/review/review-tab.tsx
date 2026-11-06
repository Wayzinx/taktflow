import { useState } from 'react'
import { ClipboardCheck, FileSearch, Gavel, GitCompareArrows, ListChecks, Undo2, Unplug, Users } from 'lucide-react'
import type { EventEnvelope, EventPayloads, NodeDetail } from '@taktflow/core'
import { EmptyState, StatusBadge } from '../../../components/ui'
import { fmtDate, fmtTime } from '../../../lib/format'
import { ArtifactDiffs, changedPairs } from './artifact-diff'
import { FacetTags, OpenCounts } from './facet-tags'
import { IssueList } from './issue-list'
import { ReviewerCards } from './round-detail'
import { REVIEW_STATUS, VERDICT_META, exhaustedRule, passRule, targetText } from './review-meta'
import { avgScore, roundViews, type RoundView } from './review-rounds'
import { RoundTimeline } from './round-timeline'
import { ReworkRecord, StopBanner } from './review-notes'
import './review.css'
import './review-v2.css'

type Rework = EventPayloads['rework.started']
type Exhausted = EventPayloads['review.exhausted']
type Arbitrated = EventPayloads['review.arbitrated']

/** 裁决事件只带修订内轮次号：按时间归到最近一次同轮次号的评审上，得到全局 seq。 */
function arbitrationsBySeq(views: RoundView[], events: EventEnvelope[]): Map<number, Arbitrated> {
  const out = new Map<number, Arbitrated>()
  for (const e of events) {
    if (e.type !== 'review.arbitrated') continue
    const d = e.data as Arbitrated
    const v = [...views].reverse().find((x) => x.round === d.round && (!x.r.records[0] || Date.parse(x.r.records[0].at) <= Date.parse(e.ts)))
    if (v) out.set(v.seq, d)
  }
  for (const v of views) if (!out.has(v.seq) && v.r.records.some((x) => x.arbiter)) {
    const a = v.r.records.find((x) => x.arbiter)!
    out.set(v.seq, { round: v.round, arbiter: a.reviewer, verdict: a.verdict, conflict: '评审者结论冲突' })
  }
  return out
}

/**
 * 节点抽屉 · 评审（kind=review 时显示）：三枚正交标签、修订时间线（修订 → 轮次，打回处断开）、
 * 评审者结论、问题清单（观察标记 + 作者回应 + 人工处置）、轮次间产物差异、早停与裁决、打回记录。
 */
export function ReviewTab({ d, runId, requirementId }: { d: NodeDetail; runId: string; requirementId: string }) {
  const review = d.review
  const views = review ? roundViews(review.rounds, review.config.maxRounds) : []
  const [picked, setPicked] = useState<number>()
  if (!review || !views.length)
    return (
      <div className="dpad rv">
        {review && <FacetTags facets={review.facets} />}
        <EmptyState compact icon={ClipboardCheck} title="评审尚未出结论" hint={review ? `修订 1 · 最多 ${review.config.maxRounds} 轮；评审者给出结论后显示在这里` : `${requirementId} · ${runId}`} />
      </div>
    )

  const { config, status, facets } = review
  const reworks = d.events.filter((e) => e.type === 'rework.started').map((e) => e.data as Rework)
  const exhaustedEvents = d.events.filter((e) => e.type === 'review.exhausted').map((e) => e.data as Exhausted)
  const reworkExhausted = exhaustedEvents.filter((x) => x.action === 'rework')
  const arbitrations = arbitrationsBySeq(views, d.events)
  const last = views[views.length - 1]!
  const view = views.find((v) => v.seq === picked) ?? last
  const idx = views.indexOf(view)
  const prev = idx > 0 ? views[idx - 1] : undefined
  const revIndex = [...new Set(views.map((v) => v.revision))].indexOf(view.revision)
  const endsRevision = views[idx + 1] ? views[idx + 1]!.revision !== view.revision : false
  const live = status === 'in_review' || status === 'revising'
  const threshold = typeof config.pass === 'object' ? config.pass.minScore : undefined
  const exhaustedHere = !view.r.passed && (endsRevision || view.round === config.maxRounds || view.r.stopReason === 'no_progress')
  const avg = avgScore(view.r)
  const arb = arbitrations.get(view.seq)
  const stop = exhaustedEvents.find((x) => x.reason === 'no_progress') ?? (views.some((v) => v.r.stopReason === 'no_progress') ? { rounds: last.round, action: 'human' as const, reason: 'no_progress' as const } : undefined)

  return (
    <div className="dpad rv">
      <div className="rv-head">
        <StatusBadge meta={REVIEW_STATUS[status]} />
        <FacetTags facets={facets} />
        <span style={{ flex: 1 }} />
        <span className="rv-head-round">
          修订 <b className="num">{last.revision}</b> · 第 <b className="num">{last.round}</b>/<span className="num">{config.maxRounds}</span> 轮
        </span>
        {reworks.length > 0 && (
          <span className="rv-chip rework">
            <Undo2 />
            打回 <span className="num">{reworks.length}</span> 次
          </span>
        )}
      </div>
      {facets && (
        <div className="rv-open">
          <span className="rv-open-label">未关闭</span>
          <OpenCounts open={facets.open} />
        </div>
      )}
      {stop && <StopBanner stop={stop} config={config} />}
      <dl className="rv-facts">
        <dt>评审对象</dt>
        <dd className="mono">{targetText(config.target)}</dd>
        <dt>作者</dt>
        <dd className="mono">{config.author}</dd>
        <dt>评审者</dt>
        <dd>
          {config.reviewers.map((r) => (
            <span key={r.role} className="rv-chip" title={r.focus}>
              <span className="mono">{r.role}</span>
              {r.focus && <span className="faint">· {r.focus}</span>}
            </span>
          ))}
        </dd>
        {config.arbiter && (
          <>
            <dt>裁决者</dt>
            <dd>
              <span className="rv-chip"><Gavel /><span className="mono">{config.arbiter.role}</span></span>
              <span className="faint">只在评审者结论冲突时介入</span>
            </dd>
          </>
        )}
        <dt>通过规则</dt>
        <dd>{passRule(config.pass)}{config.humanSignoff ? ' · 同意后交人确认' : ''}</dd>
        <dt>结束条件</dt>
        <dd>
          轮次用完{exhaustedRule(config.onExhausted)}
          {config.stopAfterNoProgress !== 0 && <span className="faint"> · 连续 {config.stopAfterNoProgress ?? 2} 轮无进展提前结束</span>}
        </dd>
      </dl>

      <section className="d-section">
        <div className="d-section-title">
          <ListChecks />
          修订与轮次
          <span className="d-section-hint faint">点选查看某一轮 · #后为全局序号</span>
        </div>
        <RoundTimeline views={views} maxRounds={config.maxRounds} reworks={reworks} exhausted={reworkExhausted} arbitrated={new Set(arbitrations.keys())} selected={view.seq} onSelect={setPicked} live={live} />
      </section>

      <section className="d-section rv-round fade-in" key={view.seq}>
        <div className="rv-round-head">
          <span className="rv-round-title">
            <span className="faint">修订 {view.revision} · </span>第 {view.round} 轮
          </span>
          <span className="mono faint">#{view.seq}</span>
          <span className={`rv-outcome ${view.r.passed ? 'pass' : 'fail'}`}>{view.r.passed ? (view.r.records.some((x) => x.issues.length) ? '同意' : '无问题') : '未同意'}</span>
          {avg !== undefined && <span className="faint num">均分 {avg}</span>}
          <span style={{ flex: 1 }} />
          {view.r.records[0] && (
            <span className="faint mono num" title={view.r.records[0].at}>
              {fmtDate(view.r.records[0].at).slice(0, 5)} {fmtTime(view.r.records[0].at)}
            </span>
          )}
        </div>
        <div className="rv-seen">
          <FileSearch />
          <span className="faint">评审版本</span>
          {(view.r.records[0]?.artifacts ?? []).map((a) => (
            <span key={a.path} className="rv-chip mono">
              {a.path}@v{a.version}
            </span>
          ))}
          {view.r.targetFingerprint && !view.r.records[0]?.artifacts.length && <span className="rv-chip mono">{view.r.targetFingerprint}</span>}
        </div>
        {arb && (
          <div className="rv-arb">
            <Gavel />
            <span>
              裁决者 <span className="mono">{arb.arbiter}</span> 判定 <b>{VERDICT_META[arb.verdict].label}</b>
            </span>
            <span className="faint">· {arb.conflict}</span>
          </div>
        )}
        {view.r.stopReason === 'no_progress' && (
          <div className="rv-arb stop">
            <Unplug />
            <span>本轮后提前结束：没有新增或变化的阻断 / 重要问题</span>
          </div>
        )}

        <div className="d-section-title rv-sub">
          <Users />
          评审者结论
        </div>
        <ReviewerCards records={view.r.records} threshold={threshold} />

        <div className="d-section-title rv-sub">
          <ClipboardCheck />
          问题、观察与处置
          {view.r.revised.length > 0 && <span className="d-section-hint faint mono">修改后 {view.r.revised.map((r) => `${r.path}@v${r.version}`).join(', ')}</span>}
        </div>
        <IssueList view={view} prev={prev} isLast={view === last} exhausted={exhaustedHere} dispositions={review.dispositions} runId={runId} nodeId={d.state.id} />

        {endsRevision && reworks[revIndex] && <ReworkRecord rework={reworks[revIndex]!} exhausted={reworkExhausted[revIndex]} />}

        <div className="d-section-title rv-sub">
          <GitCompareArrows />
          与上一轮的产物差异
          {prev && <span className="d-section-hint faint">上一轮 → 本轮评审版本</span>}
        </div>
        {prev ? <ArtifactDiffs pairs={changedPairs(prev.r.records[0]?.artifacts ?? [], view.r.records[0]?.artifacts ?? [])} /> : <p className="rv-empty">首轮评审，没有可对比的上一轮。</p>}
      </section>
    </div>
  )
}
