import { useEffect, useRef, useState } from 'react'
import { Check, CheckCheck, Sparkles, X } from 'lucide-react'
import type { StewardStreamEvent } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { openSteward } from '../../lib/ui-store'
import { parseAcceptance, suggestAcceptance } from './estimate'

type Item = { id: number; text: string; state: 'pending' | 'accepted' | 'rejected' }

const PROMPT = (title: string, text: string) =>
  `请为下面这个需求补全验收标准。只输出 3 到 6 条可验证的验收标准，每条一行、以"- "开头，不要别的内容；描述里没有的具体数字不要编造。\n\n标题：${title}\n\n描述：\n${text.trim() || '（无）'}`

/**
 * "让管家补全验收标准"：配置了管家模型时真的问管家（开一个会话，流式读回复，逐条解析成可接受 / 拒绝的条目）；
 * 没配置模型时明确标成"规则模板"，用本地通用条目，不冒充管家、不加思考动画。每条单独接受（插入"验收标准"段）或拒绝。
 */
export function AcceptanceAssist({ text, title, onInsert }: { text: string; title: string; onInsert: (item: string) => void }) {
  const ds = useSource()
  const info = useAsync((d) => d.serverInfo().catch(() => undefined), [])
  const live = !!info.data?.steward.configured
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'streaming' | 'done'>('idle')
  const [mode, setMode] = useState<'steward' | 'rules'>('rules')
  const [items, setItems] = useState<Item[]>([])
  const [error, setError] = useState<string>()
  const [threadId, setThreadId] = useState<string>()
  const off = useRef<() => void>(() => {})
  const stop = () => {
    off.current()
    off.current = () => {}
  }
  useEffect(() => stop, [])
  // 新条目出现时让它进入视野（对话框正文可滚动）
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!items.length) return
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
  }, [items.length])

  const fresh = (all: string[]) => {
    const existing = text.toLowerCase()
    return all.filter((s) => !existing.includes(s.slice(0, 12).toLowerCase()))
  }
  const rules = () => {
    setMode('rules')
    setItems(fresh(suggestAcceptance(text, title)).map((s, i) => ({ id: i, text: s, state: 'pending' })))
    setPhase('done')
  }
  const ask = async () => {
    setMode('steward')
    setPhase('thinking')
    try {
      const r = await ds.createStewardThread({ text: PROMPT(title, text) })
      setThreadId(r.thread.id)
      let replyId: string | undefined
      let reply = ''
      const show = (done: boolean) => {
        const parsed = fresh(parseAcceptance(reply))
        // 已决定的条目保留状态；新解析出的条目追加
        setItems((cur) => parsed.map((t, i) => cur.find((x) => x.text === t) ?? { id: i, text: t, state: 'pending' }))
        setPhase(done ? 'done' : 'streaming')
      }
      off.current = ds.subscribeSteward(r.thread.id, (e: StewardStreamEvent) => {
        if (e.type === 'message' && e.message.role === 'steward') {
          replyId = e.message.id
          reply = e.message.text.length >= reply.length ? e.message.text : reply
          show(e.message.status === 'done' || e.message.status === 'error')
        } else if (e.type === 'delta' && e.messageId === replyId) {
          reply += e.text
          show(false)
        } else if (e.type === 'done' && e.messageId === replyId) {
          show(true)
          stop()
        } else if (e.type === 'error' && e.messageId === replyId) {
          setError(e.error)
          setPhase('done')
          stop()
        }
      })
    } catch (e) {
      setError((e as Error).message)
      setPhase('done')
    }
  }
  const start = () => {
    stop()
    setItems([])
    setError(undefined)
    setThreadId(undefined)
    if (live) void ask()
    else rules()
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
      <button type="button" className="btn btn-sm btn-ghost rc-ac-trigger" onClick={start} disabled={!title} title={!title ? '先写一句要做什么' : live ? '管家按描述逐条给出验收标准，你来挑' : '管家还没配置模型：先用通用的规则模板'}>
        <Sparkles />
        {live || !info.data ? '让管家补全验收标准' : '补全验收标准（规则模板）'}
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
            {mode === 'rules' ? '规则模板 · ' : '管家建议 '}
            <span className="num">{items.length}</span> 条验收标准
            {phase === 'streaming' && <span className="stream-caret" aria-hidden />}
          </span>
        )}
        {threadId && phase === 'done' && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openSteward({ threadId })} title="在管家里继续追问">
            看对话
          </button>
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
      {error && (
        <p className="rc-pop-empty">
          管家没能给出建议：{error}
          {/* 模型暂时不可用（中转 503 等）时给一条退路：明确标成规则模板，不冒充管家 */}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => (stop(), setError(undefined), setThreadId(undefined), rules())}>
            改用规则模板
          </button>
        </p>
      )}
      {mode === 'rules' && phase === 'done' && <p className="rc-pop-empty">{live ? '管家这次没能回答，' : '未配置管家模型，'}下面是通用的规则模板，不是针对这份描述的分析。</p>}
      {phase === 'done' && !error && items.length === 0 && <p className="rc-pop-empty">{mode === 'rules' ? '描述里已经覆盖了常见的验收点，没有更多建议。' : '管家这次没有给出新的条目，可以换一批或补充描述。'}</p>}
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
