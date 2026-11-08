import type { CSSProperties } from 'react'
import { BellRing, Lightbulb, Undo2 } from 'lucide-react'
import type { HumanTimebox } from '@taktflow/core'
import { useSecondTick } from './activity-line'
import './timebox.css'

/** `30m` / `2h` / `1d` / `90s` → 毫秒；认不出返回 undefined。 */
export function spanMs(s: string | undefined): number | undefined {
  const m = s && /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(s.trim())
  if (!m) return undefined
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']
}

function left(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

/**
 * 等人限时（docs/design/26 §3）：一条细进度条从创建走到交还时限；没有交还（审批 / 选择、或没给假设）就走到第二轮提醒。
 * 刻度是两轮提醒（第一轮提醒派给的人，第二轮加上负责人）；离交还不到 20% 时染琥珀。
 */
export function TimeboxBar({ createdAt, timebox, assumption, form, remindedAt, handedBack, compact }: { createdAt: string; timebox: HumanTimebox; assumption?: string; form?: string; remindedAt?: string[]; handedBack?: boolean; compact?: boolean }) {
  const now = useSecondTick(!handedBack)
  const start = Date.parse(createdAt)
  const remind = spanMs(timebox.remindAfter)
  const canHandback = form === 'answer' && Boolean(assumption)
  const handback = canHandback ? spanMs(timebox.handbackAfter) : undefined
  const total = handback ?? (remind ? remind * 2 : undefined)
  if (!total) return null
  const marks = remind ? [remind, remind * 2].filter((m) => m < total || handback === undefined) : []
  const t = now - start
  const p = Math.min(1, t / total)
  const near = handback !== undefined && !handedBack && handback - t < handback * 0.2
  const over = handback === undefined && t >= total
  const rounds = remindedAt?.length ?? 0
  const nextRemind = remind && rounds < 2 ? remind * (rounds + 1) : undefined
  let text: string
  if (handedBack) text = '没等到回答，已按假设交还给 Agent 继续'
  else if (handback !== undefined && t >= handback) text = '已到交还时限，下一次检查时按假设交还'
  else if (handback !== undefined) text = `${nextRemind && nextRemind < handback && t < nextRemind ? `${left(nextRemind - t)}后${rounds ? '再提醒' : '提醒'} · ` : rounds ? `已提醒 ${rounds} 次 · ` : ''}${left(handback - t)}后按假设交还`
  else if (nextRemind && t < nextRemind) text = `${rounds ? `已提醒派给的人 · ${left(nextRemind - t)}后再提醒并抄送负责人` : `${left(nextRemind - t)}后提醒`}${form === 'approve' || form === 'choice' ? ' · 不会自动通过' : ''}`
  else text = rounds >= 2 ? `已提醒两次（含负责人）${form === 'approve' || form === 'choice' ? ' · 不会自动通过，等人处理' : ''}` : '已到提醒时限'
  return (
    <div className={`tbx${near || over ? ' is-near' : ''}${handedBack ? ' is-back' : ''}${compact ? ' is-compact' : ''}`}>
      <div className="tbx-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} aria-label="等人时限">
        <span className="tbx-fill" style={{ '--p': p } as CSSProperties} />
        {marks.map((m, i) => (
          <i key={m} className={`tbx-mark${rounds > i ? ' is-done' : ''}`} style={{ left: `${(m / total) * 100}%` }} title={i === 0 ? `${timebox.remindAfter} 提醒派给的人` : '再提醒一次，抄送负责人'} />
        ))}
      </div>
      <div className="tbx-text">
        {handedBack ? <Undo2 /> : rounds ? <BellRing /> : null}
        <span>{text}</span>
      </div>
      {assumption && !compact && (
        <p className="tbx-assume">
          <Lightbulb />
          <span>
            <b>{handedBack ? '按这个假设推进：' : '到时按这个假设推进：'}</b>
            {assumption}
          </span>
        </p>
      )}
    </div>
  )
}
