import { Undo2, Unplug } from 'lucide-react'
import type { EventPayloads } from '@taktflow/core'
import { exhaustedRule, type ReviewConfig } from './review-meta'
import { reworkReason } from './round-timeline'

type Rework = EventPayloads['rework.started']
type Exhausted = EventPayloads['review.exhausted']

const ACTION_TEXT: Record<Exhausted['action'], string> = { rework: '打回上游重做', human: '交给人处理', fail: '判为失败' }

/** 早停：连续 stopAfterNoProgress 轮没有新增 / 变化的 blocker、major 问题仍不通过，提前按 onExhausted 处理。 */
export function StopBanner({ stop, config }: { stop: Exhausted; config: ReviewConfig }) {
  const n = config.stopAfterNoProgress ?? 2
  return (
    <div className="rv-stop" role="note">
      <Unplug />
      <div>
        <b>提前结束，没有再烧轮次</b>
        <p>
          连续 <span className="num">{n}</span> 轮没有新增或变化的阻断 / 重要问题，评审仍未同意；在第 <span className="num">{stop.rounds}</span> 轮后按"轮次用完{exhaustedRule(config.onExhausted)}"处理：{ACTION_TEXT[stop.action]}。
        </p>
      </div>
    </div>
  )
}

/** 一个修订结束时的打回记录：去哪、为什么、重置了哪些节点、交给上游的反馈。 */
export function ReworkRecord({ rework, exhausted }: { rework: Rework; exhausted?: Exhausted }) {
  return (
    <div className="rv-rework">
      <div className="rv-rework-head">
        <Undo2 />
        <b>
          打回 <span className="mono">{rework.to}</span> 重做，开启下一个修订
        </b>
        <span className="faint num">第 {rework.count} 次打回</span>
      </div>
      <p className="rv-rework-why">{reworkReason(undefined, exhausted)}</p>
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
