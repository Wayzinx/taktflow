import { useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { CornerUpLeft, SendHorizontal, X } from 'lucide-react'
import type { RoomMember, RoomMessage } from '@taktflow/core'
import { toast } from '../../../components/ui'
import { MemberAvatar } from './message-item'

export interface ComposerApi {
  mention(id: string): void
  focus(): void
}

/** 光标前的 @片段（@ 前面是行首或空白才算）。 */
function mentionQuery(text: string, caret: number): { start: number; q: string } | undefined {
  const m = /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[2]!.length - 1, q: m[2]!.toLowerCase() } : undefined
}

/** 从正文里认出 @成员（含 @lead）。 */
export function parseMentions(text: string, members: RoomMember[]): string[] {
  const ids = new Set([...text.matchAll(/(?:^|\s)@([\w-]+)/g)].map((x) => x[1]!))
  return members.filter((m) => ids.has(m.id)).map((m) => m.id)
}

export function Composer({ members, replyTo, onCancelReply, onSend, apiRef }: { members: RoomMember[]; replyTo?: RoomMessage; onCancelReply(): void; onSend(text: string, mentions: string[]): Promise<void>; apiRef?: Ref<ComposerApi> }) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number>()
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  const query = mentionQuery(text, caret)
  const options = useMemo(() => {
    if (!query) return []
    // Lead 永远排第一：群里最常 @ 的就是它
    const sorted = [...members].sort((a, b) => Number(b.kind === 'lead') - Number(a.kind === 'lead'))
    return sorted.filter((m) => m.id.toLowerCase().startsWith(query.q) || m.name.toLowerCase().includes(query.q) || (m.role ?? '').includes(query.q)).slice(0, 8)
  }, [members, query?.q, query?.start]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = Boolean(query) && options.length > 0 && dismissed !== query?.start

  function setDraft(next: string, pos: number) {
    setText(next)
    setCaret(pos)
    requestAnimationFrame(() => {
      ta.current?.focus()
      ta.current?.setSelectionRange(pos, pos)
    })
  }

  function pick(m: RoomMember) {
    if (!query) return
    const before = text.slice(0, query.start)
    const after = text.slice(caret)
    const ins = `@${m.id} `
    setDraft(before + ins + after.replace(/^\s+/, ''), before.length + ins.length)
    setActive(0)
  }

  useImperativeHandle(apiRef, () => ({
    mention(id) {
      const sep = text && !/\s$/.test(text) ? ' ' : ''
      const next = `${text}${sep}@${id} `
      setDraft(next, next.length)
    },
    focus: () => ta.current?.focus(),
  }))

  async function submit() {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await onSend(body, parseMentions(body, members))
      setText('')
      setCaret(0)
    } catch (e) {
      toast('发送失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
      ta.current?.focus()
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + d + options.length) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(options[Math.min(active, options.length - 1)]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(query?.start)
        return
      }
    }
    if (e.key === 'Escape' && replyTo) onCancelReply()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const listId = 'chat-mention-list'
  return (
    <div className="chat-composer">
      {replyTo && (
        <div className="chat-replying">
          <CornerUpLeft aria-hidden="true" />
          <span className="truncate">回复：{replyTo.text}</span>
          <button className="btn btn-sm btn-ghost btn-icon" aria-label="取消回复" onClick={onCancelReply}>
            <X />
          </button>
        </div>
      )}
      {open && (
        <ul className="chat-mention-menu" id={listId} role="listbox" aria-label="选择要 @ 的成员">
          {options.map((m, i) => (
            <li key={m.id} id={`${listId}-${m.id}`} role="option" aria-selected={i === active} className={i === active ? 'active' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)} onMouseEnter={() => setActive(i)}>
              <MemberAvatar kind={m.kind} name={m.name} />
              <span className="mono">@{m.id}</span>
              <span className="faint truncate">{m.role ?? m.name}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="chat-input-row">
        <textarea
          ref={ta}
          className="textarea chat-input"
          rows={2}
          value={text}
          placeholder="发消息，@lead 让 Lead 处理，@ 成员通知对方"
          aria-label="群聊消息"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${options[active]!.id}` : undefined}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            setActive(0)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <button className="btn btn-primary chat-send" disabled={busy || !text.trim()} onClick={() => void submit()}>
          <SendHorizontal />
          发送
        </button>
      </div>
      <div className="chat-hint faint">
        <span className="kbd">↵</span> 发送 · <span className="kbd">⇧</span> <span className="kbd">↵</span> 换行 · <span className="kbd">@</span> 补全成员
      </div>
    </div>
  )
}
