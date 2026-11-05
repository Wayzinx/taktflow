import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { WorkflowRevision } from '@taktflow/core'
import { toast } from '../../../components/ui'
import type { WorkflowDocState } from '../state'

/** 回滚到某个历史修订：原因必填（写进新修订），回滚本身是一次新修订，不改写历史。 */
export function RollbackForm({ wf, rev, onDone }: { wf: WorkflowDocState; rev: WorkflowRevision; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const short = rev.rev.slice(0, 8)
  const blocked = wf.status === 'conflict' ? '先处理保存冲突' : wf.status === 'saving' ? '等待保存完成' : undefined

  if (!open)
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)} disabled={!!blocked} title={blocked}>
        <RotateCcw />
        回滚到此修订
      </button>
    )

  const submit = async () => {
    setBusy(true)
    const ok = await wf.rollback(rev.rev, reason.trim())
    setBusy(false)
    if (!ok) return
    toast(`已回滚到 ${short}`, { body: '回滚生成了一条新修订，可以再回滚回来。', tone: 'success' })
    setOpen(false)
    setReason('')
    onDone()
  }

  return (
    <form
      className="wfc-rollback"
      onSubmit={(e) => {
        e.preventDefault()
        if (reason.trim()) void submit()
      }}
    >
      <label className="wfc-field-label" htmlFor="wfc-rollback-reason">
        回滚原因（必填，会写进新修订）
      </label>
      <textarea
        id="wfc-rollback-reason"
        className="textarea"
        rows={2}
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={`例如：${short} 之后的评审规则导致误打回，先恢复`}
      />
      <div className="wfc-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} disabled={busy}>
          取消
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !reason.trim()}>
          {busy ? '回滚中…' : `确认回滚到 ${short}`}
        </button>
      </div>
    </form>
  )
}
