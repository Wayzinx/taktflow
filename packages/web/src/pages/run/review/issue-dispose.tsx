import { useEffect, useRef, useState } from 'react'
import { Check, RotateCcw, X } from 'lucide-react'
import type { ReviewDisposition } from '@taktflow/core'
import { invalidate, useSource } from '../../../api'
import { toast } from '../../../components/ui'
import { actorName, fmtRelative } from '../../../lib/format'
import { usePresence, useLastDefined } from '../../../lib/motion'
import { DISPOSITION } from './review-meta'
import { Tag } from './facet-tags'

type State = ReviewDisposition['state']

const ACTION: Record<State, { label: string; verb: string; placeholder: string }> = {
  resolved: { label: '已解决', verb: '标为已解决', placeholder: '怎么解决的（例如：v3 已补充跨时区用例）' },
  dismissed: { label: '驳回', verb: '驳回', placeholder: '为什么不采纳（例如：超出本需求范围，另起需求）' },
  open: { label: '重新打开', verb: '重新打开', placeholder: '为什么重新打开' },
}

export { effectiveDisposition } from './disposition'

/** 已有的处置：状态标签 + 原因 + 谁 / 何时。 */
export function DispositionNote({ d, expired }: { d: ReviewDisposition; expired?: boolean }) {
  const m = DISPOSITION[d.state]
  return (
    <div className={`rv-dispo-note${expired ? ' expired' : ''}`}>
      <Tag tone={expired ? 'neutral' : m.tone}>{expired ? `${m.label}（已失效）` : m.label}</Tag>
      <span className="rv-dispo-reason">{expired ? '问题有变化，之前的处置自动失效：' : ''}{d.reason}</span>
      <span className="faint mono rv-dispo-by" title={d.at}>
        {actorName(d.by)} · {fmtRelative(d.at)}
      </span>
    </div>
  )
}

/**
 * 人工处置：已解决 / 驳回 / 重新打开，必须填原因；`ds.disposeReview`（服务端转成命令 `review.dispose`，进审计）。
 * 原因输入框是一个带进出场的小面板（usePresence），快速重开会打断退出。
 */
export function DisposeActions({ runId, nodeId, groupKey, current }: { runId: string; nodeId: string; groupKey: string; current?: State }) {
  const ds = useSource()
  const [pending, setPending] = useState<State>()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const p = usePresence(Boolean(pending), 140)
  const shown = useLastDefined(pending)
  useEffect(() => {
    if (pending) input.current?.focus()
  }, [pending])

  const closed = current === 'resolved' || current === 'dismissed'
  const choices: State[] = closed ? ['open'] : ['resolved', 'dismissed']

  async function submit() {
    if (!pending || !reason.trim()) return
    setBusy(true)
    try {
      await ds.disposeReview(runId, nodeId, { groupKey, state: pending, reason: reason.trim() })
      toast(`${ACTION[pending].label}：${groupKey}`, { body: ds.mock ? '演示数据：处置已记入本页内存中的审计日志。' : '处置已记录，评审状态会重新计算。' })
      setPending(undefined)
      setReason('')
      invalidate()
    } catch (e) {
      toast('处置失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rv-dispo">
      <div className="rv-dispo-actions">
        <span className="rv-dispo-label">人工处置</span>
        {choices.map((s) => {
          const Icon = s === 'resolved' ? Check : s === 'dismissed' ? X : RotateCcw
          return (
            <button key={s} type="button" className={`btn btn-sm btn-ghost${pending === s ? ' on' : ''}`} aria-expanded={pending === s} onClick={() => setPending(pending === s ? undefined : s)}>
              <Icon />
              {ACTION[s].label}
            </button>
          )
        })}
      </div>
      {p.mounted && shown && (
        <div className="rv-dispo-form" data-state={p.state}>
          <textarea
            ref={input}
            className="textarea"
            rows={2}
            placeholder={`${ACTION[shown].placeholder}（必填，进审计）`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPending(undefined)
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
          <div className="rv-dispo-form-foot">
            <span className="faint">
              <span className="kbd">⌘</span> <span className="kbd">↵</span> 提交 · <span className="kbd">Esc</span> 取消
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setPending(undefined)}>
              取消
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !reason.trim() || !pending} onClick={() => void submit()}>
              {ACTION[shown].verb}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
