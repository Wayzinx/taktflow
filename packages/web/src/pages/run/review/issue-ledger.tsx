import type { CSSProperties } from 'react'
import { Check, ChevronRight, CircleDashed, CircleDot, KeyRound, ShieldOff, X } from 'lucide-react'
import type { ReviewIssueEntry } from '@taktflow/core'
import { fmtTime } from '../../../lib/format'
import type { Tone } from '../../../lib/status'
import { Tag } from './facet-tags'
import { SeverityTag } from './round-detail'
import './issue-ledger.css'

type Status = ReviewIssueEntry['status']
type Action = ReviewIssueEntry['history'][number]['action']

/**
 * 问题状态（docs/design/21 §3）：作者说修好了（claimed）和评审者复查确认（verified）分开显示——
 * 虚线勾 = 只有作者的说法，实线勾 = 评审者逐键复查给了 resolved。
 */
export const ISSUE_STATUS: Record<Status, { label: string; tone: Tone | 'neutral'; hint: string }> = {
  open: { label: '未关闭', tone: 'failed', hint: '还没有人声称修好，或复查仍有问题' },
  claimed_fixed: { label: '作者称已修', tone: 'waiting', hint: '只有作者的回应，评审者还没复查确认' },
  verified_fixed: { label: '复查已确认', tone: 'success', hint: '评审者在下一轮逐键复查，给了 resolved' },
  dismissed: { label: '人工不采纳', tone: 'neutral', hint: '人工处置：不是问题' },
  waived: { label: '人工放行', tone: 'neutral', hint: '人工处置：接受风险' },
}

const ACTION: Record<Action, string> = {
  raised: '提出',
  reobserved: '再次提出',
  claimed_fixed: '作者称已修',
  verified_fixed: '复查确认已修',
  still_open: '复查仍有问题',
  not_checked: '本轮未复查',
  dismissed: '人工不采纳',
  waived: '人工放行',
  reopened: '重新打开',
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'verified_fixed') return <Check className="iss-ic solid" strokeWidth={2.6} />
  if (status === 'claimed_fixed') return <CircleDashed className="iss-ic dashed" strokeWidth={2.2} />
  if (status === 'open') return <CircleDot className="iss-ic" strokeWidth={2.2} />
  return status === 'dismissed' ? <X className="iss-ic" strokeWidth={2.4} /> : <ShieldOff className="iss-ic" strokeWidth={2.2} />
}

export function IssueStatusTag({ status, notChecked }: { status: Status; notChecked?: boolean }) {
  const m = ISSUE_STATUS[status]
  return (
    <Tag tone={m.tone} icon={<StatusIcon status={status} />} title={notChecked ? `${m.hint}；本轮评审者没给复查结论` : m.hint} className={`iss-st iss-${status}`}>
      {m.label}
      {notChecked && <span className="iss-nc">· 本轮未复查</span>}
    </Tag>
  )
}

/** 系统问题键：引擎分配，跨修订有效；模型不能自造。 */
export function IssueKey({ k, onClick }: { k: string; onClick?: () => void }) {
  return onClick ? (
    <button type="button" className="iss-key mono" onClick={onClick} title="看这个问题的经过">
      {k}
    </button>
  ) : (
    <span className="iss-key mono">{k}</span>
  )
}

/** 问题台账：节点内每个问题键一行，点开看经过（提出 → 作者回应 → 复查）。 */
export function IssueLedger({ issues, focus, onFocus }: { issues: ReviewIssueEntry[]; focus?: string; onFocus: (key?: string) => void }) {
  const counts = issues.reduce<Partial<Record<Status, number>>>((m, i) => ({ ...m, [i.status]: (m[i.status] ?? 0) + 1 }), {})
  return (
    <div className="iss-ledger">
      <div className="iss-sum">
        {(['open', 'claimed_fixed', 'verified_fixed', 'dismissed', 'waived'] as const).filter((s) => counts[s]).map((s) => (
          <span key={s} className={`iss-sum-item iss-${s}`}>
            <StatusIcon status={s} />
            {ISSUE_STATUS[s].label} <b className="num">{counts[s]}</b>
          </span>
        ))}
      </div>
      <ul className="iss-list">
        {issues.map((e, i) => (
          <LedgerRow key={e.key} e={e} i={i} open={focus === e.key} onToggle={() => onFocus(focus === e.key ? undefined : e.key)} />
        ))}
      </ul>
    </div>
  )
}

function LedgerRow({ e, i, open, onToggle }: { e: ReviewIssueEntry; i: number; open: boolean; onToggle: () => void }) {
  const lastCheck = [...e.history].reverse().find((h) => h.action === 'not_checked' || h.action === 'verified_fixed' || h.action === 'still_open')
  return (
    <li className={`iss-row${open ? ' open' : ''}`} style={{ '--i': i } as CSSProperties} id={`iss-${e.key}`}>
      <button type="button" className="iss-row-head" onClick={onToggle} aria-expanded={open}>
        <ChevronRight className="iss-caret" />
        <IssueKey k={e.key} />
        <SeverityTag severity={e.severity} />
        <span className="iss-title truncate">{e.title}</span>
        <span style={{ flex: 1 }} />
        <IssueStatusTag status={e.status} notChecked={e.status === 'claimed_fixed' && lastCheck?.action === 'not_checked'} />
      </button>
      {open && (
        <ol className="iss-hist">
          {e.history.map((h, k) => (
            <li key={k} className={`iss-step a-${h.action}`} style={{ '--k': k } as CSSProperties}>
              <span className="iss-step-dot" />
              <span className="iss-step-where mono num">
                r{h.revision}.{h.round}
              </span>
              <b>{ACTION[h.action]}</b>
              <span className="mono faint">{h.by}</span>
              {h.note && <span className="iss-step-note">{h.note}</span>}
              <span className="iss-step-at mono num faint">{fmtTime(h.at)}</span>
            </li>
          ))}
          {e.duty && (
            <li className="iss-duty">
              <KeyRound />
              对应职责：{e.duty}
            </li>
          )}
        </ol>
      )}
    </li>
  )
}
