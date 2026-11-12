import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronRight, CircleAlert, CircleCheck, CircleStop, Copy, CornerDownRight, Forward, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { Proposal, StewardContextRef, StewardDelegation, StewardMessage } from '@taktflow/core'
import { useSource } from '../../api'
import { Bee } from '../mascot'
import { normReceipt, ReceiptRail, ResendButton } from '../receipt'
import { Link } from '../../lib/router'
import { spacePath } from '../../lib/space'
import { stewardAction } from '../../lib/actions'
import { Menu, toast } from '../ui'
import { hm } from './fmt'
import { StewardBlocks } from './blocks'
import { StewardText } from './citation'
import { stripCitations } from './cite-text'
import { ProposalCard } from './proposal-card'
import { ToolList } from './tool-card'

const DOWN_REASONS = [
  { id: 'wrong', label: '答错了' },
  { id: 'missed', label: '没答到点' },
  { id: 'verbose', label: '太啰嗦' },
  { id: 'bad_action', label: '操作不对' },
]

function Feedback({ m, onPatch }: { m: StewardMessage; onPatch: (patch: Partial<StewardMessage>) => void }) {
  const ds = useSource()
  const down = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const rate = async (rating: 'up' | 'down', reason?: string) => {
    const prev = m.feedback
    onPatch({ feedback: { rating, reason, at: new Date().toISOString() } })
    try {
      await ds.stewardFeedback(m.id, { rating, reason })
      if (rating === 'down') toast('谢谢反馈', { body: '这条会进入管家周报，用来改进回答' })
    } catch (e) {
      onPatch({ feedback: prev })
      toast('反馈没有送达', { tone: 'failed', body: (e as Error).message })
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stripCitations(m.text))
      toast('已复制', { tone: 'success', duration: 2000 })
    } catch {
      toast('浏览器不允许复制', { tone: 'failed' })
    }
  }
  const r = m.feedback?.rating
  return (
    <div className="stw-msg-actions">
      <button type="button" className="btn btn-ghost btn-icon btn-sm" title="复制" aria-label="复制" onClick={() => void copy()}>
        <Copy />
      </button>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" title="有帮助" aria-label="有帮助" aria-pressed={r === 'up'} onClick={() => void rate('up')}>
        <ThumbsUp />
      </button>
      <button ref={down} type="button" className="btn btn-ghost btn-icon btn-sm" title="没帮助" aria-label="没帮助" aria-pressed={r === 'down'} aria-haspopup="menu" onClick={() => setMenu(true)}>
        <ThumbsDown />
      </button>
      {r === 'down' && m.feedback?.reason && <span className="faint">{DOWN_REASONS.find((x) => x.id === m.feedback?.reason)?.label ?? m.feedback.reason}</span>}
      <Menu open={menu} onClose={() => setMenu(false)} anchor={down} ariaLabel="哪里不好" items={DOWN_REASONS.map((x, i) => ({ id: x.id, label: x.label, section: i === 0 ? '哪里不好' : undefined, checked: m.feedback?.reason === x.id, onSelect: () => void rate('down', x.id) }))} />
    </div>
  )
}

/** 思考摘要：流式且还没正文时扫光显示；之后默认折叠。 */
/** 思考摘要（折叠）；进行中的状态统一由底部的 LiveStatus 显示，这里不再扫光。 */
function Thinking({ text, live }: { text?: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="stw-thinking-wrap">
      <button type="button" className="stw-thinking pressable" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Brain aria-hidden />
        <span>{live ? '思考过程' : '思考摘要'}</span>
        <ChevronRight className="stw-chev" aria-hidden />
      </button>
      <div className="expand" data-open={open}>
        <div>
          <p className="stw-thinking-body">{text}</p>
        </div>
      </div>
    </div>
  )
}

/**
 * 回复进行中的状态行：扫光文字 + 已用时，放在这条回复最下面，回复完才消失。
 * 正文流出来之后光标不显眼，没有这一行容易以为已经答完了。
 */
function LiveStatus({ m }: { m: StewardMessage }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  // 正文最近 2 秒还在长才算「正在回答」；外部 harness 调工具前会先说一句过程说明，之后停下来想，不能一直显示在回答
  const grew = useRef({ len: m.text.length, at: 0 })
  if (m.text.length !== grew.current.len) grew.current = { len: m.text.length, at: Date.now() }
  const running = (m.tools ?? []).find((t) => t.ok === undefined)
  const label = running ? `正在${stewardAction(running).full}` : m.text && now - grew.current.at < 2000 ? '正在回答' : '正在思考'
  const secs = Math.max(0, Math.round((now - Date.parse(m.at)) / 1000))
  return (
    <div className="stw-live" role="status">
      <span className="stw-live-glyph" aria-hidden>
        <svg viewBox="0 0 16 16">
          <path d="M8 1.6v12.8M2.46 4.8l11.08 6.4M2.46 11.2l11.08-6.4" />
        </svg>
      </span>
      <span className="shimmer-text truncate">{label}</span>
      <span className="num">{secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}</span>
    </div>
  )
}

export interface MessageViewProps {
  m: StewardMessage
  proposals: Record<string, Proposal>
  /** 新到的消息淡入上移 160ms；首屏已有的不播。 */
  animate?: boolean
  /** 只给最后一条管家回复显示后续建议。 */
  showSuggestions?: boolean
  onProposal: (p: Proposal) => void
  onPatch: (patch: Partial<StewardMessage>) => void
  /** 追问；ctx 给了就用它作这条消息的上下文（候选块点选）。 */
  onSuggest: (text: string, ctx?: StewardContextRef[]) => void
  /** 只给最后一条、失败或被停下的回复：重发前面那条提问。 */
  onRetry?: () => void
}

/**
 * 管家转达 Lead 的回执（docs/design/26 §4）：已发出 → 已接手 → 已回复；
 * 不确定时写明"可能已送达，重发前先看群聊"，由人决定重发。
 */
function Delegation({ d: initial }: { d: StewardDelegation }) {
  const ds = useSource()
  const [d, setD] = useState(initial)
  useEffect(() => setD(initial), [initial])
  const status = normReceipt(d.status)
  const room = spacePath(d.spaceId, `/req/${encodeURIComponent(d.requirementId)}?tab=chat`)
  return (
    <div className={`stw-delegation st-${status}`}>
      <Forward aria-hidden />
      <div className="stw-delegation-main">
        <div className="stw-delegation-head">
          <span>
            已转达 <Link to={room} className="mono">{d.requirementId}</Link> 的 Lead
          </span>
          <ReceiptRail status={d.status} kind="relay" compact />
        </div>
        {status === 'replied' && d.reply && <p className="stw-delegation-reply">{d.reply}</p>}
        {(status === 'uncertain' || status === 'expired') && (
          <div className="stw-delegation-act">
            <span className="faint">{status === 'uncertain' ? '可能已送达，重发前请先看群聊。' : '30 分钟没有人接手。'}</span>
            <ResendButton
              status={d.status}
              what="这条转达"
              roomHref={room}
              onResend={async (reason) => {
                setD(await ds.resendDelegation(d.messageId, reason))
                toast('已重发转达', { body: `${d.requirementId} 的 Lead 回复后会出现在这里。` })
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** 一条消息：用户气泡；管家回复依次是思考 → 工具卡 → 正文（[n] 引用）→ 提案卡 → 最多 3 条后续建议。 */
export function MessageView({ m, proposals, animate, showSuggestions, onProposal, onPatch, onSuggest, onRetry }: MessageViewProps) {
  if (m.role === 'user')
    return (
      <div className={`stw-msg stw-msg-user${animate ? ' stw-in' : ''}`} data-steward-anchor={m.id}>
        <div className="stw-bubble">{m.text}</div>
        {m.status === 'error' && (
          <span className="stw-msg-err">
            <CircleAlert aria-hidden />
            没发出去：{m.error}
          </span>
        )}
      </div>
    )
  // 系统消息：批准的提案执行完回到会话的那一行，管家紧接着往下说
  if (m.role === 'system') {
    const failed = (m.proposalIds ?? []).some((id) => proposals[id]?.results?.some((r) => !r.ok))
    return (
      <div className={`stw-msg stw-msg-system${failed ? ' is-failed' : ''}${animate ? ' stw-in' : ''}`} data-steward-anchor={m.id}>
        {failed ? <CircleAlert aria-hidden /> : <CircleCheck aria-hidden />}
        <span className="stw-msg-system-text">{m.text}</span>
        <span className="faint num">{hm(m.at)}</span>
      </div>
    )
  }
  const live = m.status === 'streaming'
  const delegations = m.delegations ?? []
  return (
    <article className={`stw-msg stw-msg-steward${animate ? ' stw-in' : ''}`} data-steward-anchor={m.id} aria-busy={live}>
      {/* 只有正在回复的那条头像会动，历史消息静止 */}
      <Bee className="stw-avatar" state={live ? 'think' : m.status === 'error' ? 'failed' : 'idle'} still={!live} size={30} />
      <div className="stw-msg-main">
        <div className="stw-msg-meta">
          <span className="stw-msg-who">管家</span>
          <span className="faint num">{hm(m.at)}</span>
          {m.offline && <span className="stw-tag">规则回复</span>}
        </div>
        <Thinking text={m.thinking} live={live} />
        {(m.tools ?? []).length > 0 && (
          <ToolList tools={m.tools!} live={live} />
        )}
        {m.text && <StewardText text={m.text} citations={m.citations} streaming={live} />}
        {(m.blocks ?? []).length > 0 && <StewardBlocks blocks={m.blocks!} onAsk={onSuggest} />}
        {(m.status === 'error' || m.status === 'stopped') && (
          <div className="stw-msg-end">
            {m.status === 'error' ? (
              <p className="stw-msg-err">
                <CircleAlert aria-hidden />
                {m.error ?? '回复中断了'}
              </p>
            ) : (
              <p className="stw-msg-stopped">
                <CircleStop aria-hidden />
                {m.error ? `已停止：${m.error}` : '已停止'}
              </p>
            )}
            {onRetry && (
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                <RotateCcw aria-hidden />
                重试
              </button>
            )}
          </div>
        )}
        {delegations.map((d) => (
          <Delegation key={d.messageId} d={d} />
        ))}
        {(m.proposalIds ?? []).map((id) => (proposals[id] ? <ProposalCard key={id} proposal={proposals[id]!} onChange={onProposal} animate={live || animate} /> : null))}
        {live && <LiveStatus m={m} />}
        {(!m.status || m.status === 'done') && (
          <div className="stw-msg-foot">
            <Feedback m={m} onPatch={onPatch} />
          </div>
        )}
        {showSuggestions && !live && (m.suggestions ?? []).length > 0 && <FollowUps items={m.suggestions!} onPick={onSuggest} />}
      </div>
    </article>
  )
}

/** 后续建议：点了直接发出（页头建议是"预填"，这里是接着问）。 */
function FollowUps({ items, onPick }: { items: string[]; onPick: (t: string) => void }) {
  return (
    <div className="suggest-row stw-followups" aria-label="接着问">
      {items.slice(0, 3).map((s) => (
        <button key={s} type="button" className="suggest-chip pressable" onClick={() => onPick(s)}>
          <CornerDownRight aria-hidden />
          <span className="truncate">{s}</span>
        </button>
      ))}
    </div>
  )
}
