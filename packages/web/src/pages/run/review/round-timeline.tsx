import { Check, PenLine, Undo2 } from 'lucide-react'
import type { EventPayloads, ReviewRound } from '@taktflow/core'
import { fmtTime } from '../../../lib/format'
import { avgScore, cyclesOf, issueCount, localRound } from './review-meta'

type Rework = EventPayloads['rework.started']

/**
 * 轮次时间线：按评审周期分组（打回重做后重新从第 1 轮数起），周期之间插一个"打回"节点。
 * 每轮是一个可选中的刻度：通过 / 要求修改用图标 + 文字区分，不只靠颜色。
 */
export function RoundTimeline({ rounds, maxRounds, reworks, selected, onSelect, live }: { rounds: ReviewRound[]; maxRounds: number; reworks: Rework[]; selected: number; onSelect: (round: number) => void; live: boolean }) {
  const cycles = cyclesOf(rounds, maxRounds)
  const last = rounds[rounds.length - 1]?.round
  return (
    <ol className="rv-timeline" aria-label="评审轮次">
      {cycles.map((c) => (
        <li key={c.index} className="rv-cycle">
          {c.index > 0 && <ReworkStep rework={reworks[c.index - 1]} count={c.index} />}
          <div className="rv-cycle-body">
            {cycles.length > 1 && <div className="rv-cycle-label">{c.index === 0 ? '首次评审' : `打回后第 ${c.index} 次`}</div>}
            <div className="rv-steps">
              {c.rounds.map((r) => {
                const n = localRound(r.round, maxRounds)
                const avg = avgScore(r)
                const issues = issueCount(r)
                const current = live && r.round === last
                return (
                  <button
                    key={r.round}
                    type="button"
                    className={`rv-step ${r.passed ? 'pass' : 'fail'}${r.round === selected ? ' selected' : ''}${current ? ' current' : ''}`}
                    aria-pressed={r.round === selected}
                    onClick={() => onSelect(r.round)}
                    title={`全局第 ${r.round} 轮 · ${fmtTime(r.records[0]?.at ?? '')}`}
                  >
                    <span className="rv-step-mark">{r.passed ? <Check strokeWidth={2.6} /> : <PenLine strokeWidth={2.4} />}</span>
                    <span className="rv-step-text">
                      <span className="rv-step-title">
                        第 <span className="num">{n}</span> / <span className="num">{maxRounds}</span> 轮
                      </span>
                      <span className="rv-step-sub">
                        {r.passed ? '通过' : `${issues} 个问题`}
                        {avg !== undefined && <span className="num"> · 均分 {avg}</span>}
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

function ReworkStep({ rework, count }: { rework?: Rework; count: number }) {
  return (
    <div className="rv-rework-step" title={rework?.feedback}>
      <Undo2 strokeWidth={2.2} />
      <span>
        打回 <span className="mono">{rework?.to ?? '上游'}</span>
        <span className="faint num"> · 第 {rework?.count ?? count} 次</span>
      </span>
    </div>
  )
}
