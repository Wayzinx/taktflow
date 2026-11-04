import { useState } from 'react'
import { ArrowUpRight, Check, CornerDownLeft, MessageSquareText, ShieldAlert, UserRoundCheck, X } from 'lucide-react'
import type { AttentionItem } from '@taktflow/core'
import { invalidate, useSource } from '../api'
import { fmtRelative } from '../lib/format'
import { Link } from '../lib/router'
import { toast } from './ui'
import './attention-card.css'

const FORM_META = {
  approve: { label: '审批', icon: UserRoundCheck },
  answer: { label: '回答', icon: MessageSquareText },
  choice: { label: '裁决', icon: ShieldAlert },
} as const

/** 一条待办：审批 / 回答 / 选择，可以直接在卡片里处理。 */
export function AttentionCard({ item, reqTitle, compact }: { item: AttentionItem; reqTitle?: string; compact?: boolean }) {
  const ds = useSource()
  const [text, setText] = useState('')
  const [choice, setChoice] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(!compact)
  const meta = FORM_META[item.form]
  const Icon = meta.icon
  const answered = Boolean(item.answeredAt)

  async function submit(body: { decision?: string; answer?: string }, label: string) {
    setBusy(true)
    try {
      await ds.answer(item.requestId, body)
      toast(`${label}：${item.requirementId} · ${item.nodeId}`, { body: ds.mock ? '演示数据：已记入本页内存中的审计日志。' : '已提交，运行将自动继续。' })
      invalidate()
    } catch (e) {
      toast('提交失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`att-card${compact ? ' compact' : ''}${answered ? ' answered' : ''}`}>
      <div className="att-head">
        <span className={`att-form att-f-${item.form}`}>
          <Icon />
          {meta.label}
        </span>
        <Link to={`/req/${item.requirementId}`} className="att-req mono">
          {item.requirementId}
        </Link>
        {reqTitle && <span className="att-req-title truncate">{reqTitle}</span>}
        <span style={{ flex: 1 }} />
        <span className="att-time" title={item.createdAt}>
          {fmtRelative(item.createdAt)}
        </span>
      </div>
      <p className="att-ask">{item.ask}</p>
      <div className="att-node">
        <Link to={`/run/${item.runId}?node=${encodeURIComponent(item.nodeId)}`} className="att-node-link">
          <span className="mono">{item.nodeId}</span>
          <ArrowUpRight />
        </Link>
        <span className="faint mono">{item.runId}</span>
      </div>

      {answered ? (
        <div className="att-result">
          <Check />
          <span>
            {item.decision ? (item.decision === 'approve' ? '已通过' : item.decision === 'reject' ? '已打回' : item.decision) : '已回答'}
            {item.answer && <span className="faint"> · {item.answer}</span>}
          </span>
          <span className="faint" style={{ marginLeft: 'auto' }}>
            {fmtRelative(item.answeredAt)}
          </span>
        </div>
      ) : item.form === 'approve' ? (
        <div className="att-actions">
          {!compact && <input className="input" placeholder="意见（可选，进审计）" value={text} onChange={(e) => setText(e.target.value)} />}
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => submit({ decision: 'approve', answer: text || undefined }, '已通过')}>
            <Check />
            通过
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => submit({ decision: 'reject', answer: text || undefined }, '已打回')}>
            <X />
            打回
          </button>
        </div>
      ) : item.form === 'answer' ? (
        open ? (
          <div className="att-body">
            <textarea
              className="textarea"
              rows={compact ? 2 : 3}
              placeholder="写下答复，会同步写入 decisions/ 并进审计"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void submit({ answer: text.trim() }, '已回答')
              }}
            />
            <div className="att-actions end">
              <span className="faint att-hint">
                <span className="kbd">⌘</span> <span className="kbd">↵</span> 提交
              </span>
              <button className="btn btn-sm btn-primary" disabled={busy || !text.trim()} onClick={() => submit({ answer: text.trim() }, '已回答')}>
                <CornerDownLeft />
                提交回答
              </button>
            </div>
          </div>
        ) : (
          <div className="att-actions">
            <button className="btn btn-sm" onClick={() => setOpen(true)}>
              <MessageSquareText />
              回答
            </button>
          </div>
        )
      ) : (
        <div className="att-body">
          <div className="att-choices">
            {(item.choices ?? []).map((c) => (
              <button key={c} className={`att-choice${choice === c ? ' on' : ''}`} onClick={() => setChoice(c)}>
                <span className="att-radio" />
                {c}
              </button>
            ))}
          </div>
          {(!compact || choice) && <input className="input" placeholder="理由（放行时必填）" value={text} onChange={(e) => setText(e.target.value)} />}
          <div className="att-actions end">
            <button className="btn btn-sm btn-primary" disabled={busy || !choice || (choice.startsWith('放行') && !text.trim())} onClick={() => submit({ decision: choice, answer: text || undefined }, '已裁决')}>
              提交裁决
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
