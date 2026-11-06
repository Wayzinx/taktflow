import { Fragment } from 'react'
import { CircleHelp, CornerDownRight } from 'lucide-react'
import type { RoomMember } from '@taktflow/core'
import { MentionText } from './streaming-text'

type Seg = { kind: 'plain' | 'confirm' | 'next'; text: string }

const MARK = /\*\*(待确认|下一步)\*\*[:：]?[ \t]*/g

/** 把 Lead 消息切成：普通段落 + `**待确认**` / `**下一步**` 起头的标签块（块延续到下一个标签或结尾）。 */
export function splitLeadText(text: string): Seg[] {
  const out: Seg[] = []
  let last = 0
  let kind: Seg['kind'] = 'plain'
  for (const m of text.matchAll(MARK)) {
    const chunk = text.slice(last, m.index).trim()
    if (chunk) out.push({ kind, text: chunk })
    kind = m[1] === '待确认' ? 'confirm' : 'next'
    last = m.index! + m[0].length
  }
  const tail = text.slice(last).trim()
  if (tail || kind !== 'plain') out.push({ kind, text: tail })
  return out
}

export function hasLeadMarks(text: string): boolean {
  return /\*\*(待确认|下一步)\*\*/.test(text)
}

/** 段内的 **粗体** 渲染成 strong，其余交给 MentionText 标 @。 */
function Inline({ text, members }: { text: string; members?: RoomMember[] }) {
  const parts = text.split(/\*\*([^*\n]+)\*\*/g)
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : <Fragment key={i}>{p && <MentionText text={p} members={members} />}</Fragment>))}
    </>
  )
}

const TAG = {
  confirm: { label: '待确认', icon: CircleHelp },
  next: { label: '下一步', icon: CornerDownRight },
} as const

/**
 * Lead 消息正文：`**待确认**`（等人拍板，等人色）与 `**下一步**`（Lead 接下来要做的，墨色）
 * 渲染成醒目的标签块，扫一眼就知道要不要自己动手。
 */
export function LeadText({ text, members }: { text: string; members?: RoomMember[] }) {
  return (
    <>
      {splitLeadText(text).map((s, i) => {
        if (s.kind === 'plain')
          return (
            <p key={i}>
              <Inline text={s.text} members={members} />
            </p>
          )
        const t = TAG[s.kind]
        return (
          <div key={i} className="chat-callout" data-kind={s.kind} role="note" aria-label={t.label}>
            <span className="chat-callout-tag">
              <t.icon aria-hidden="true" />
              {t.label}
            </span>
            {s.text && (
              <p>
                <Inline text={s.text} members={members} />
              </p>
            )}
          </div>
        )
      })}
    </>
  )
}
