import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  // 防重：同一帧里连点两次时 state 里的 busy 还是 false，用 ref 在提交开头同步置位
  const pending = useRef(false)
  const errorRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    setReason('')
    setError(undefined)
    setBusy(false)
  }, [open])
  // 失败后焦点要留在框里：万一已经掉到 body（按钮被别处禁用、重绘），落到报错上
  useEffect(() => {
    if (error && (!document.activeElement || document.activeElement === document.body)) errorRef.current?.focus()
  }, [error])

  const submit = async () => {
    if (!reasonOk(reason) || pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await onSubmit(reason.trim())
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      pending.current = false
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
          {error && (
            <span ref={errorRef} className="ov-error" role="alert" tabIndex={-1}>
              {error}
            </span>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          {/* 提交中不用 disabled：获得焦点的按钮被禁用后焦点会掉到 body，Esc / Tab 都失灵；aria-disabled 保留焦点，点击由 pending 挡掉 */}
          <button type="button" className={`btn btn-sm ${risk === 'dangerous' ? 'btn-danger' : 'btn-primary'}`} disabled={!reasonOk(reason)} aria-disabled={busy || undefined} onClick={submit}>
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
