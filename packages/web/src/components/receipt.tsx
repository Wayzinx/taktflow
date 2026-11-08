import { useState, type CSSProperties } from 'react'
import { Ban, Clock3, CornerDownRight, HelpCircle, RotateCw, Waypoints } from 'lucide-react'
import type { DelegationStatus } from '@taktflow/core'
import { Link } from '../lib/router'
import { ReasonDialog } from './ui'
import './receipt.css'

/**
 * 转达 / 派发回执（docs/design/26 §4）：一排小站点——已发出 → 已接手 → 已开始 → 完成（管家转达是 → 已回复）。
 * 拒绝 / 过期 / 不确定不再往下画站点，换成一个收尾标记；不确定的连"已发出"都画成虚线，因为可能根本没送到。
 */
export type ReceiptKind = 'task' | 'relay'

export const RECEIPT_LABEL: Record<DelegationStatus, string> = {
  sent: '已发出',
  taken: '已接手',
  started: '已开始',
  done: '完成',
  replied: '已回复',
  refused: '已拒绝',
  expired: '已过期',
  uncertain: '不确定是否送达',
}

/** 旧数据：answered → replied，failed → uncertain（api.ts StewardDelegation 的约定）。 */
export function normReceipt(s: DelegationStatus | 'answered' | 'failed'): DelegationStatus {
  return s === 'answered' ? 'replied' : s === 'failed' ? 'uncertain' : s
}

const STEPS: Record<ReceiptKind, DelegationStatus[]> = {
  task: ['sent', 'taken', 'started', 'done'],
  relay: ['sent', 'taken', 'replied'],
}

const PROBLEM = { refused: Ban, expired: Clock3, uncertain: HelpCircle } as const
type Problem = keyof typeof PROBLEM
const isProblem = (s: DelegationStatus): s is Problem => s in PROBLEM

/** 走到了第几站（-1：一站都不能确认）。 */
function reachedOf(status: DelegationStatus, kind: ReceiptKind): number {
  const steps = STEPS[kind]
  if (status === 'uncertain') return -1
  if (status === 'refused' || status === 'expired') return 0
  if (kind === 'relay' && (status === 'started' || status === 'done')) return status === 'done' ? 2 : 1
  if (kind === 'task' && status === 'replied') return 3
  return steps.indexOf(status)
}

export function ReceiptRail({ status: raw, kind = 'task', compact }: { status: DelegationStatus | 'answered' | 'failed'; kind?: ReceiptKind; compact?: boolean }) {
  const status = normReceipt(raw)
  const steps = STEPS[kind]
  const reached = reachedOf(status, kind)
  const problem = isProblem(status) ? status : undefined
  const last = reached === steps.length - 1
  const shown = problem ? steps.slice(0, Math.max(1, reached + 1)) : steps
  const End = problem ? PROBLEM[problem] : undefined
  return (
    <ol className={`rcpt${compact ? ' is-compact' : ''}${problem ? ` is-${problem}` : ''}${last ? ' is-final' : ''}`} aria-label={`回执：${RECEIPT_LABEL[status]}`}>
      {shown.map((s, i) => {
        const state = problem === 'uncertain' ? 'unsure' : i < reached || (i === reached && (last || problem)) ? 'done' : i === reached ? 'cur' : 'todo'
        return (
          <li key={s} className={`rcpt-st st-${state}`} style={{ '--i': i } as CSSProperties} aria-current={state === 'cur' ? 'step' : undefined}>
            <i className="rcpt-dot" aria-hidden />
            <span>{RECEIPT_LABEL[s]}</span>
          </li>
        )
      })}
      {problem && End && (
        <li className={`rcpt-end tone-${problem}`} style={{ '--i': shown.length } as CSSProperties}>
          <End aria-hidden />
          <span>{RECEIPT_LABEL[problem]}</span>
        </li>
      )}
    </ol>
  )
}

/** 派发链：上游任务运行从早到近，最后是本任务；跳数超过上限时整条链标红。 */
export function HopChain({ hops, chain, refused }: { hops?: number; chain?: string[]; refused?: boolean }) {
  if (!hops && !chain?.length) return null
  const list = chain ?? []
  // 链太长时只留头两个和尾两个，中间折成"… N 个"
  const fold = list.length > 5
  const items = fold ? [...list.slice(0, 2), `…${list.length - 4}`, ...list.slice(-2)] : list
  return (
    <div className={`rcpt-chain${refused ? ' is-refused' : ''}`}>
      <Waypoints aria-hidden />
      <span className="rcpt-chain-hops">第 {hops ?? list.length} 跳</span>
      <span className="rcpt-chain-list">
        {items.map((id, i) => (
          <span key={`${id}-${i}`} className="rcpt-chain-item">
            {/* ux-audit: ok '…' 是跳数链的折叠标记，不是加载文案 */}
            {id.startsWith('…') ? (
              <span className="faint">… {id.slice(1)} 个 …</span>
            ) : (
              <Link to={`/run/${id}`} className="mono" title="打开上游任务运行">
                {id}
              </Link>
            )}
            <CornerDownRight className="rcpt-chain-arrow" aria-hidden />
          </span>
        ))}
        <span className={`rcpt-chain-self${refused ? ' faint' : ''}`}>{refused ? '本次派发（被拒绝）' : '本任务'}</span>
      </span>
    </div>
  )
}

/**
 * 重发：只对过期 / 不确定开放，由人决定并写原因。
 * 不确定的先提醒去群聊看一眼——可能已经送达，重发会让同一件事做两遍。
 */
export function ResendButton({ status: raw, what, onResend, roomHref }: { status: DelegationStatus | 'answered' | 'failed'; what: string; onResend: (reason: string) => Promise<void>; roomHref?: string }) {
  const status = normReceipt(raw)
  const [open, setOpen] = useState(false)
  if (status !== 'uncertain' && status !== 'expired') return null
  return (
    <>
      <button type="button" className="btn btn-xs" onClick={() => setOpen(true)}>
        <RotateCw />
        重发
      </button>
      <ReasonDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`重发${what}？`}
        confirmLabel="确认重发"
        description={
          status === 'uncertain' ? (
            <>
              上次发送时出错，<b>可能已经送达</b>。重发前先
              {roomHref ? (
                <Link to={roomHref} onClick={() => setOpen(false)}>
                  到群聊看一眼
                </Link>
              ) : (
                '在群里往下看一眼'
              )}
              有没有已经开始的同名任务，避免同一件事做两遍。
            </>
          ) : (
            '30 分钟没有人接手，已过期。重发会再交给 Lead 一次，派发链与跳数沿用原来的。'
          )
        }
        onSubmit={onResend}
      />
    </>
  )
}
