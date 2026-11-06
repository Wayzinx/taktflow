import { Check, Gavel, PenLine, Undo2, Unplug } from 'lucide-react'
import type { EventPayloads } from '@taktflow/core'
import { fmtTime } from '../../../lib/format'
import { avgScore, issueCount, revisionsOf, type RoundView } from './review-rounds'

type Rework = EventPayloads['rework.started']
type Exhausted = EventPayloads['review.exhausted']

/** 打回原因：轮次用完 / 连续无进展；反馈取第一行。 */
export function reworkReason(rework?: Rework, exhausted?: Exhausted): string {
  const why = exhausted?.reason === 'no_progress' ? '连续无进展，提前结束' : `${exhausted?.rounds ?? ''}${exhausted ? ' 轮用完' : '轮次用完'}`
  const first = rework?.feedback.split('\n').find((l) => l.trim())
  return first ? `${why} · ${first}` : why
}

/**
 * 修订时间线：修订 → 轮次。每次打回重做开启一个新修订，修订之间断开，断点上写打回去哪、为什么。
 * 每轮是一个可选中的刻度（选中键是全局 seq），通过 / 要求修改用图标 + 文字区分，不只靠颜色。
 */
export function RoundTimeline({ views, maxRounds, reworks, exhausted, arbitrated, selected, onSelect, live }: {
  views: RoundView[]
  maxRounds: number
  reworks: Rework[]
  exhausted: Exhausted[]
  arbitrated: Set<number>
  selected: number
  onSelect: (seq: number) => void
  live: boolean
}) {
  const revisions = revisionsOf(views)
  const lastSeq = views[views.length - 1]?.seq
  return (
    <ol className="rv-timeline" aria-label="评审修订与轮次">
      {revisions.map((rev, i) => (
        <li key={rev.revision} className="rv-cycle">
          {i > 0 && <ReworkBreak rework={reworks[i - 1]} exhausted={exhausted[i - 1]} />}
          <div className="rv-cycle-body">
            <div className="rv-cycle-label">
              修订 <span className="num">{rev.revision}</span>
              {i === 0 && revisions.length === 1 ? '' : i === 0 ? ' · 首次评审' : ' · 打回后重做'}
            </div>
            <div className="rv-steps">
              {rev.rounds.map((v) => {
                const avg = avgScore(v.r)
                const issues = issueCount(v.r)
                const current = live && v.seq === lastSeq
                const stopped = v.r.stopReason === 'no_progress'
                return (
                  <button
                    key={v.seq}
                    type="button"
                    className={`rv-step ${v.r.passed ? 'pass' : 'fail'}${v.seq === selected ? ' selected' : ''}${current ? ' current' : ''}`}
                    aria-pressed={v.seq === selected}
                    onClick={() => onSelect(v.seq)}
                    title={`修订 ${v.revision} · 第 ${v.round} 轮 · 全局 #${v.seq}${v.r.records[0] ? ` · ${fmtTime(v.r.records[0].at)}` : ''}`}
                  >
                    <span className="rv-step-mark">{v.r.passed ? <Check strokeWidth={2.6} /> : <PenLine strokeWidth={2.4} />}</span>
                    <span className="rv-step-text">
                      <span className="rv-step-title">
                        第 <span className="num">{v.round}</span>
                        <span className="faint">/{maxRounds}</span> 轮<span className="rv-seq mono">#{v.seq}</span>
                      </span>
                      <span className="rv-step-sub">
                        {v.r.passed ? (issues ? '同意' : '无问题') : `${issues} 个问题`}
                        {avg !== undefined && <span className="num"> · {avg}</span>}
                        {arbitrated.has(v.seq) && (
                          <span className="rv-step-flag" title="评审者结论冲突，本轮由裁决者决定">
                            <Gavel /> 裁决
                          </span>
                        )}
                        {stopped && (
                          <span className="rv-step-flag" title="连续多轮没有新增或变化的 blocker / major 问题，提前结束">
                            <Unplug /> 早停
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function ReworkBreak({ rework, exhausted }: { rework?: Rework; exhausted?: Exhausted }) {
  const reason = reworkReason(rework, exhausted)
  return (
    <div className="rv-rework-step" title={rework?.feedback ?? reason}>
      <span className="rv-break" aria-hidden />
      <span className="rv-rework-step-main">
        <Undo2 strokeWidth={2.2} />
        打回 <span className="mono">{rework?.to ?? '上游'}</span>
      </span>
      <span className="rv-rework-step-why truncate">{reason}</span>
    </div>
  )
}
