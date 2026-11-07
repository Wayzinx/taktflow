import { useEffect, useRef, useState } from 'react'
import { Check, CheckCheck, Sparkles, X } from 'lucide-react'
import { suggestAcceptance } from './estimate'

type Item = { id: number; text: string; state: 'pending' | 'accepted' | 'rejected' }

/**
 * "让管家补全验收标准"：管家逐条给出验收标准，每条单独接受（插入文本框的"验收标准"段）或拒绝。
 * 思考中用扫光；条目一条条出现（流式）。
 */
export function AcceptanceAssist({ text, title, onInsert }: { text: string; title: string; onInsert: (item: string) => void }) {
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'streaming' | 'done'>('idle')
  const [items, setItems] = useState<Item[]>([])
  const timers = useRef<number[]>([])
  const stop = () => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current = []
  }
  useEffect(() => stop, [])
  // 新条目出现时让它进入视野（对话框正文可滚动）
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!items.length) return
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
  }, [items.length])

  const start = () => {
    stop()
    setItems([])
    setPhase('thinking')
    const existing = text.toLowerCase()
    const list = suggestAcceptance(text, title).filter((s) => !existing.includes(s.slice(0, 12).toLowerCase()))
    timers.current.push(
      window.setTimeout(() => {
        setPhase('streaming')
        list.forEach((s, i) =>
          timers.current.push(
            window.setTimeout(() => {
              setItems((xs) => [...xs, { id: i, text: s, state: 'pending' }])
              if (i === list.length - 1) setPhase('done')
            }, i * 260),
          ),
        )
        if (!list.length) setPhase('done')
      }, 700),
    )
  }
  const decide = (id: number, state: 'accepted' | 'rejected') => {
    const it = items.find((x) => x.id === id)
    if (!it || it.state !== 'pending') return
    if (state === 'accepted') onInsert(it.text)
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, state } : x)))
  }
  const pending = items.filter((x) => x.state === 'pending')

  if (phase === 'idle')
    return (
      <button type="button" className="btn btn-sm btn-ghost rc-ac-trigger" onClick={start} disabled={!title} title={title ? '管家按描述逐条给出验收标准，你来挑' : '先写一句要做什么'}>
        <Sparkles />
        让管家补全验收标准
      </button>
    )

  return (
    <section className="rc-ac" aria-label="管家建议的验收标准" aria-live="polite">
      <header className="rc-ac-head">
        <Sparkles aria-hidden />
        {phase === 'thinking' ? (
          <span className="shimmer-text">管家在读你的描述</span>
        ) : (
          <span>
            建议 <span className="num">{items.length}</span> 条验收标准
            {phase === 'streaming' && <span className="stream-caret" aria-hidden />}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {pending.length > 1 && phase === 'done' && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => pending.forEach((p) => decide(p.id, 'accepted'))}>
            <CheckCheck />
            全部接受
          </button>
        )}
        {phase === 'done' && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={start}>
            换一批
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="收起建议" title="收起" onClick={() => (stop(), setPhase('idle'))}>
          <X />
        </button>
      </header>
      {phase === 'done' && items.length === 0 && <p className="rc-pop-empty">描述里已经覆盖了常见的验收点，没有更多建议。</p>}
      <ul className="rc-ac-list" ref={list}>
        {items.map((it) => (
          <li key={it.id} className={`rc-ac-item ${it.state}`}>
            <span className="rc-ac-text">{it.text}</span>
            {it.state === 'pending' ? (
              <span className="rc-ac-actions">
                <button type="button" className="btn btn-sm" onClick={() => decide(it.id, 'accepted')} title="插入到文本的验收标准段">
                  <Check />
                  接受
                </button>
                <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={() => decide(it.id, 'rejected')} aria-label="拒绝这条" title="拒绝">
                  <X />
                </button>
              </span>
            ) : (
              <span className="rc-ac-state">{it.state === 'accepted' ? '已插入' : '已拒绝'}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
