import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import type { DeviceLink } from '../../api/index.js'
import { Dialog } from '../../components/ui/dialog.js'
import { DEVICE_ID, linkCommand, linkHub } from './model.js'

export type Pairing = DeviceLink & { hub: string; spaceId: string }

export function DeviceTime({ value }: { value: string }) {
  const date = new Date(value)
  return <time dateTime={value}>{Number.isFinite(date.getTime()) ? date.toLocaleString() : '时间未知'}</time>
}

function CopyValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [feedback, setFeedback] = useState('')
  const text = useRef<HTMLElement>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setFeedback(`${label}已复制。`)
    } catch {
      if (!text.current) return
      const range = document.createRange()
      range.selectNodeContents(text.current)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      setFeedback(`无法自动复制，请手动复制${label}。`)
    }
  }
  return (
    <div className="device-copy">
      <div className="device-copy-label"><strong>{label}</strong><button type="button" className="btn btn-sm" onClick={() => void copy()}><Copy aria-hidden /> 复制{label}</button></div>
      <code className="device-copy-value" ref={text} data-private={secret || undefined}>{value}</code>
      <span className="device-copy-feedback" role="status">{feedback}</span>
    </div>
  )
}

function ConnectFields({ hub, busy, formId, onLink }: { hub: string; busy: boolean; formId: string; onLink: (nodeId: string, hub: string) => void }) {
  const [nodeId, setNodeId] = useState('')
  const [address, setAddress] = useState(hub)
  const [error, setError] = useState<{ field: 'node' | 'hub'; text: string }>()
  return (
    <form id={formId} className="device-form" onSubmit={(event) => {
      event.preventDefault()
      if (busy) return
      const id = nodeId.trim()
      if (!DEVICE_ID.test(id)) return setError({ field: 'node', text: '以字母或数字开头，只使用英文字母、数字、点、短横线或下划线。' })
      const target = linkHub(address)
      if (!target) return setError({ field: 'hub', text: '填写 HTTPS Hub，或使用执行机器上的本机 HTTP 隧道地址。不要带路径、凭据、查询参数或片段。' })
      setError(undefined)
      onLink(id, target)
    }}>
      <label className="ov-field">
        <span className="ov-field-label">设备 ID</span>
        <input className="input" data-autofocus required maxLength={128} value={nodeId} placeholder="例如 mac-mini" disabled={busy} autoComplete="off" spellCheck={false}
          aria-invalid={error?.field === 'node' || undefined} aria-describedby={error?.field === 'node' ? `${formId}-node-error` : undefined}
          onChange={(event) => { setNodeId(event.target.value); setError(undefined) }} />
        {error?.field === 'node' && <span className="device-error" id={`${formId}-node-error`} role="alert">{error.text}</span>}
      </label>
      <label className="ov-field">
        <span className="ov-field-label">命令使用的 Hub 地址</span>
        <input className="input mono" type="text" inputMode="url" required value={address} disabled={busy} autoComplete="off" spellCheck={false}
          aria-invalid={error?.field === 'hub' || undefined} aria-describedby={`${formId}-hub-hint${error?.field === 'hub' ? ` ${formId}-hub-error` : ''}`}
          onChange={(event) => { setAddress(event.target.value); setError(undefined) }} />
        <span className="ov-field-hint" id={`${formId}-hub-hint`}>优先用设备可访问的 HTTPS Hub。远程机器不能直接用浏览器所在机器的回环地址；可在执行机器上建立本机隧道，再填隧道地址。</span>
        {error?.field === 'hub' && <span className="device-error" id={`${formId}-hub-error`} role="alert">{error.text}</span>}
      </label>
      <p>Agent：<strong>Codex</strong>（目前唯一支持配对的 Agent）</p>
    </form>
  )
}

export function ConnectDialog({ open, hub, pairing, expired, error, busy, onClose, onLink }: {
  open: boolean; hub: string; pairing?: Pairing; expired: boolean; error?: string; busy: boolean
  onClose: () => void; onLink: (nodeId: string, hub: string) => void
}) {
  const formId = useId()
  const result = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (open && (pairing || expired)) result.current?.focus() }, [open, pairing, expired])
  let content: ReactNode
  if (open && pairing) content = <div className="device-pairing">
    <h3 ref={result} tabIndex={-1}>在目标设备的终端运行</h3>
    <p>在已构建的 Taktflow 仓库根目录运行。先安装并配置 Codex，再把 <code>/path/to/checkout</code> 换成任务使用的检出目录。命令提示时，粘贴一次性配对码。</p>
    <CopyValue label="命令" value={linkCommand(pairing.hub, pairing.spaceId, pairing.nodeId)} />
    <CopyValue label="配对码" value={pairing.code} secret />
    <p>只在本弹窗显示，<DeviceTime value={pairing.expiresAt} /> 到期。关闭后无法找回；需要重配时，请先撤销旧连接。</p>
  </div>
  else if (open && expired) content = <div className="device-pairing">
    <h3 ref={result} tabIndex={-1}>配对码已过期</h3>
    <p>关闭弹窗并检查设备状态。如果尚未接入且列表仍有旧记录，先撤销再重新连接。</p>
  </div>
  else if (open) content = <ConnectFields hub={hub} busy={busy} formId={formId} onLink={onLink} />

  return <Dialog open={open} onClose={onClose} dismissible={false} className="device-dialog" title="连接 Mac 或服务器" description="为当前空间登记设备，并在目标机器上运行配对命令。"
    footer={<><button type="button" className="btn" onClick={onClose}>{pairing || expired ? '关闭' : '取消'}</button>
      {!pairing && !expired && <button className="btn btn-primary" type="submit" form={formId} disabled={busy} aria-busy={busy}>生成配对码</button>}</>}>
    {content}
    {open && error && <p className="device-error" role="alert">{error}</p>}
  </Dialog>
}
