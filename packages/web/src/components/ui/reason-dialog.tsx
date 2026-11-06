import { useEffect, useState, type ReactNode } from 'react'
import { Eye, PenLine, ShieldAlert, type LucideIcon } from 'lucide-react'
import type { CommandInfo } from '@taktflow/core'
import { Dialog } from './dialog'

export type Risk = CommandInfo['risk']

/** 命令风险的图标与说明（⌘K、处置、经验启停共用）。 */
export const RISK: Record<Risk, { icon: LucideIcon; label: string; hint: string }> = {
  read: { icon: Eye, label: '只读', hint: '只查询，不改状态' },
  write: { icon: PenLine, label: '写入', hint: '会改变状态，需要写原因（进审计）' },
  dangerous: { icon: ShieldAlert, label: '危险', hint: '不可逆或会写到外部，需要写原因（进审计）' },
}

export function RiskTag({ risk, compact }: { risk: Risk; compact?: boolean }) {
  const m = RISK[risk]
  const Icon = m.icon
  return (
    <span className={`risk-tag risk-${risk}`} title={m.hint}>
      <Icon aria-hidden />
      {!compact && m.label}
    </span>
  )
}

/** 原因输入框：write / dangerous 操作的统一写法（必填，至少 2 个字）。 */
export function ReasonField({ value, onChange, risk = 'write', placeholder, autoFocus }: { value: string; onChange: (v: string) => void; risk?: Risk; placeholder?: string; autoFocus?: boolean }) {
  return (
    <label className="ov-field">
      <span className="ov-field-label">
        原因 <span className="ov-req">必填</span>
        <span className="ov-field-hint">{RISK[risk].hint}</span>
      </span>
      <textarea className="textarea" rows={3} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? '写给审计和队友看：为什么这样做'} autoFocus={autoFocus} data-autofocus={autoFocus || undefined} />
    </label>
  )
}

export const reasonOk = (s: string) => s.trim().length >= 2

/**
 * 需要原因的确认框：驳回评审问题、退役经验、终止运行等。
 * onSubmit 返回 Promise 时按钮显示进行中；抛错时把消息留在框里，不关闭。
 */
export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  risk = 'write',
  confirmLabel = '确认',
  children,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  risk?: Risk
  confirmLabel?: string
  children?: ReactNode
  onSubmit: (reason: string) => void | Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!open) return
    setReason('')
    setError(undefined)
    setBusy(false)
  }, [open])

  const submit = async () => {
    if (!reasonOk(reason) || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit(reason.trim())
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      tone={risk === 'dangerous' ? 'danger' : 'default'}
      dismissible={!reason.trim()}
      footer={
        <>
          {error && <span className="ov-error">{error}</span>}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className={`btn btn-sm ${risk === 'dangerous' ? 'btn-danger' : 'btn-primary'}`} disabled={!reasonOk(reason) || busy} onClick={submit}>
            {busy ? '提交中…' : confirmLabel}
          </button>
        </>
      }
    >
      <form
        className="ov-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
        }}
      >
        {children}
        <ReasonField value={reason} onChange={setReason} risk={risk} autoFocus />
      </form>
    </Dialog>
  )
}
