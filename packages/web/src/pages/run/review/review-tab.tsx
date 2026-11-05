import { useState } from 'react'
import { ClipboardCheck, FileSearch, GitCompareArrows, ListChecks, Undo2, Users } from 'lucide-react'
import type { EventPayloads, NodeDetail } from '@taktflow/core'
import { EmptyState, StatusBadge } from '../../../components/ui'
import { fmtDate, fmtTime } from '../../../lib/format'
import { ArtifactDiffs, changedPairs } from './artifact-diff'
import { IssueList, ReviewerCards } from './round-detail'
import { REVIEW_STATUS, avgScore, cyclesOf, exhaustedRule, localRound, normalizeRounds, passRule, targetText } from './review-meta'
import { RoundTimeline } from './round-timeline'
import './review.css'

type Rework = EventPayloads['rework.started']

/**
 * 节点抽屉 · 评审（kind=review 时显示）：轮次时间线、评审者结论与分数、问题清单与作者回应、轮次间产物差异、打回记录。
 * 数据在 d.review（config / rounds / status）；打回详情取自节点事件里的 rework.started。
 */
export function ReviewTab({ d, runId, requirementId }: { d: NodeDetail; runId: string; requirementId: string }) {
  const review = d.review
  const rounds = review ? normalizeRounds(review.rounds, review.config.maxRounds) : []
  const [picked, setPicked] = useState<number>()
  if (!review || !rounds.length) return <div className="dpad"><EmptyState compact icon={ClipboardCheck} title="评审尚未开始" hint={review ? `最多 ${review.config.maxRounds} 轮` : `${requirementId} · ${runId}`} /></div>

  const { config, status } = review
  const reworks = d.events.filter((e) => e.type === 'rework.started').map((e) => e.data as Rework)
  const last = rounds[rounds.length - 1]!
  const round = rounds.find((r) => r.round === picked) ?? last
  const idx = rounds.indexOf(round)
  const prev = idx > 0 ? rounds[idx - 1] : undefined
  const cycles = cyclesOf(rounds, config.maxRounds)
  const cycle = Math.floor((round.round - 1) / config.maxRounds)
  const live = status === 'in_review' || status === 'revising'
  const threshold = typeof config.pass === 'object' ? config.pass.minScore : undefined
  const exhaustedHere = !round.passed && localRound(round.round, config.maxRounds) === config.maxRounds
  const avg = avgScore(round)

  return (
    <div className="dpad rv">
      <div className="rv-head">
        <StatusBadge meta={REVIEW_STATUS[status]} />
        <span className="rv-head-round">
          第 <b className="num">{localRound(last.round, config.maxRounds)}</b> / <span className="num">{config.maxRounds}</span> 轮
        </span>
        {reworks.length > 0 && (
          <span className="rv-chip rework">
            <Undo2 />
            打回 <span className="num">{reworks.length}</span> 次
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="faint">{passRule(config.pass)}{config.humanSignoff ? ' · 通过后交人确认' : ''}</span>
      </div>
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
        <dt>轮次用完</dt>
        <dd>{exhaustedRule(config.onExhausted)}</dd>
      </dl>

      <section className="d-section">
        <div className="d-section-title">
          <ListChecks />
          轮次
          <span className="d-section-hint faint">点选查看某一轮</span>
        </div>
        <RoundTimeline rounds={rounds} maxRounds={config.maxRounds} reworks={reworks} selected={round.round} onSelect={setPicked} live={live} />
      </section>

      <section className="d-section rv-round fade-in" key={round.round}>
        <div className="rv-round-head">
          <span className="rv-round-title">
            {cycles.length > 1 && <span className="faint">{cycle === 0 ? '首次评审 · ' : `打回后第 ${cycle} 次 · `}</span>}第 {localRound(round.round, config.maxRounds)} 轮
          </span>
          <span className={`rv-outcome ${round.passed ? 'pass' : 'fail'}`}>{round.passed ? '通过' : '未通过'}</span>
          {avg !== undefined && <span className="faint num">均分 {avg}</span>}
          <span style={{ flex: 1 }} />
          {round.records[0] && (
            <span className="faint mono num" title={round.records[0].at}>
              {fmtDate(round.records[0].at).slice(0, 5)} {fmtTime(round.records[0].at)}
            </span>
          )}
        </div>
        <div className="rv-seen">
          <FileSearch />
          <span className="faint">评审版本</span>
          {(round.records[0]?.artifacts ?? []).map((a) => (
            <span key={a.path} className="rv-chip mono">
              {a.path}@v{a.version}
            </span>
          ))}
        </div>

        <div className="d-section-title rv-sub">
          <Users />
          评审者结论
        </div>
        <ReviewerCards records={round.records} threshold={threshold} />

        <div className="d-section-title rv-sub">
          <ClipboardCheck />
          问题清单与作者回应
          {round.revised.length > 0 && <span className="d-section-hint faint mono">修改后 {round.revised.map((r) => `${r.path}@v${r.version}`).join(', ')}</span>}
        </div>
        <IssueList round={round} isLast={round === last} exhausted={exhaustedHere} />

        {exhaustedHere && reworks[cycle] && <ReworkRecord rework={reworks[cycle]!} />}

        <div className="d-section-title rv-sub">
          <GitCompareArrows />
          与上一轮的产物差异
          {prev && <span className="d-section-hint faint">上一轮 → 本轮评审版本</span>}
        </div>
        {prev ? <ArtifactDiffs pairs={changedPairs(prev.records[0]?.artifacts ?? [], round.records[0]?.artifacts ?? [])} /> : <p className="rv-empty">首轮评审，没有可对比的上一轮。</p>}
      </section>
    </div>
  )
}

function ReworkRecord({ rework }: { rework: Rework }) {
  return (
    <div className="rv-rework">
      <div className="rv-rework-head">
        <Undo2 />
        <b>轮次用完，打回 <span className="mono">{rework.to}</span> 重做</b>
        <span className="faint num">第 {rework.count} 次打回</span>
      </div>
      {rework.reset.length > 0 && (
        <div className="rv-rework-reset">
          <span className="faint">重置节点</span>
          {rework.reset.map((n) => (
            <span key={n} className="rv-chip mono">
              {n}
            </span>
          ))}
        </div>
      )}
      {rework.feedback && (
        <details className="rv-rework-feedback">
          <summary>交给上游的反馈</summary>
          <pre>{rework.feedback}</pre>
        </details>
      )}
    </div>
  )
}
