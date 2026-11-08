import { useRef, useState } from 'react'
import { Bot, Brain, ChevronRight, CircleAlert, Copy, CornerDownRight, Forward, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { Proposal, StewardMessage } from '@taktflow/core'
import { useSource } from '../../api'
import { Menu, toast } from '../ui'
import { hm } from './fmt'
import { StewardBlocks } from './blocks'
import { StewardText } from './citation'
import { ProposalCard } from './proposal-card'
import { ToolCard } from './tool-card'

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
      await navigator.clipboard.writeText(m.text.replace(/\[\d+\]/g, ''))
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
function Thinking({ text, live }: { text?: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (live && !text)
    return (
      <div className="stw-thinking">
        <Brain aria-hidden />
        <span className="shimmer-text">正在思考</span>
      </div>
    )
  if (!text) return null
  return (
    <div className="stw-thinking-wrap">
      <button type="button" className="stw-thinking pressable" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Brain aria-hidden />
        <span className={live ? 'shimmer-text' : undefined}>{live ? '正在思考' : '思考摘要'}</span>
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

export interface MessageViewProps {
  m: StewardMessage
  proposals: Record<string, Proposal>
  /** 新到的消息淡入上移 160ms；首屏已有的不播。 */
  animate?: boolean
  /** 只给最后一条管家回复显示后续建议。 */
  showSuggestions?: boolean
  onProposal: (p: Proposal) => void
  onPatch: (patch: Partial<StewardMessage>) => void
  onSuggest: (text: string) => void
}

/** 一条消息：用户气泡；管家回复依次是思考 → 工具卡 → 正文（[n] 引用）→ 提案卡 → 最多 3 条后续建议。 */
export function MessageView({ m, proposals, animate, showSuggestions, onProposal, onPatch, onSuggest }: MessageViewProps) {
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
  const live = m.status === 'streaming'
  const delegations = m.delegations ?? []
  return (
    <article className={`stw-msg stw-msg-steward${animate ? ' stw-in' : ''}`} data-steward-anchor={m.id} aria-busy={live}>
      <div className="stw-avatar" aria-hidden>
        <Bot />
      </div>
      <div className="stw-msg-main">
        <div className="stw-msg-meta">
          <span className="stw-msg-who">管家</span>
          <span className="faint num">{hm(m.at)}</span>
          {m.offline && <span className="stw-tag">规则回复</span>}
        </div>
        <Thinking text={m.thinking} live={live && !m.text} />
        {(m.tools ?? []).length > 0 && (
          <div className="stw-tools">
            {m.tools!.map((t) => (
              <ToolCard key={t.id} tool={t} animate={live} />
            ))}
          </div>
        )}
        {m.text && <StewardText text={m.text} citations={m.citations} streaming={live} />}
        {(m.blocks ?? []).length > 0 && <StewardBlocks blocks={m.blocks!} onAsk={onSuggest} />}
        {m.status === 'error' && (
          <p className="stw-msg-err">
            <CircleAlert aria-hidden />
            {m.error ?? '回复中断了'}
          </p>
        )}
        {delegations.map((d) => (
          <div key={d.messageId} className="stw-delegation">
            <Forward aria-hidden />
            <span>
              已转达 {d.requirementId} 的 Lead · {d.status === 'answered' ? `回复：${d.reply}` : d.status === 'failed' ? '没送达' : '等回复'}
            </span>
          </div>
        ))}
        {(m.proposalIds ?? []).map((id) => (proposals[id] ? <ProposalCard key={id} proposal={proposals[id]!} onChange={onProposal} animate={live || animate} /> : null))}
        {!live && m.status !== 'error' && (
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
