import { Fragment, useEffect, useState } from 'react'
import type { RoomMember } from '@taktflow/core'

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** 把 @成员 标成提及；未知的 @xxx 原样保留。 */
export function MentionText({ text, members }: { text: string; members?: RoomMember[] }) {
  const parts = text.split(/(@[\w-]+)/g)
  return (
    <>
      {parts.map((p, i) => {
        const id = p.startsWith('@') ? p.slice(1) : undefined
        const m = id ? members?.find((x) => x.id === id) : undefined
        if (!m) return <Fragment key={i}>{p}</Fragment>
        return (
          <span key={i} className={`chat-mention who-${m.kind}`} title={m.role ? `${m.name} · ${m.role}` : m.name}>
            {p}
          </span>
        )
      })}
    </>
  )
}

/**
 * Lead / Agent 回复逐字流出：按拍子分批吐字，总时长封顶，长消息不会拖很久。
 * 读屏只读完整文本（流出的部分 aria-hidden），减少动效时直接显示全文。
 */
export function StreamingText({ text, members, onDone }: { text: string; members?: RoomMember[]; onDone?: () => void }) {
  const chars = [...text]
  const [n, setN] = useState(() => (reducedMotion() ? chars.length : 0))
  useEffect(() => {
    if (n >= chars.length) {
      onDone?.()
      return
    }
    // 约 40 字 / 秒，最长 3.2 秒流完
    const step = Math.max(1, Math.ceil(chars.length / 128))
    const t = setTimeout(() => setN((x) => Math.min(chars.length, x + step)), 25)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, chars.length])
  const done = n >= chars.length
  if (done) return <MentionText text={text} members={members} />
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {chars.slice(0, n).join('')}
        <span className="chat-caret" />
      </span>
    </>
  )
}
