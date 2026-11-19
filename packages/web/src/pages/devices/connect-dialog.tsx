import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, Copy, Download } from 'lucide-react'
import type { ComputerDetails, DeviceLink, SpaceDevice } from '../../api/devices.js'
import { Dialog } from '../../components/ui/dialog.js'
import { LINK_DOWNLOAD, linkCommand, linkDownloadCommand, linkHub, loopbackHub, PLATFORM_LABEL } from './model.js'

export type Pairing = DeviceLink & ComputerDetails & { hub: string; spaceId: string }

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

function InstallLink({ pairing }: { pairing: Pairing }) {
  const { hub, platform, spaceId, nodeId, code, expiresAt } = pairing
  const local = loopbackHub(hub)
  const [remote, setRemote] = useState(!local)
  const [address, setAddress] = useState(local ? '' : hub)
  const target = remote ? linkHub(address) : linkHub(hub)
  const mustSetAddress = remote && !target
  const editAddress = <label className="ov-field device-hub-field">
    <span className="ov-field-label">目标电脑可访问的 Hub 地址</span>
    <input className="input" value={address} onChange={e => setAddress(e.target.value)} autoComplete="off" inputMode="url" placeholder="https://hub.example.com" spellCheck={false} />
    <span className="ov-field-hint">填写此 Hub 的 HTTPS 地址。使用隧道时，填写目标电脑上的本机转发地址。</span>
  </label>
  return <div className="device-pairing">
    {local && <fieldset className="device-location">
      <legend>Link 将在哪里运行？</legend>
      <label><input type="radio" checked={!remote} onChange={() => setRemote(false)} /> Hub 本机</label>
      <label><input type="radio" checked={remote} onChange={() => setRemote(true)} /> 另一台电脑</label>
      <p>当前 Hub 使用本机地址。另一台电脑需要能访问同一个 Hub。</p>
    </fieldset>}
    {remote && (local || !linkHub(hub) ? editAddress : <details className="device-hub-options"><summary>更改 Hub 地址</summary>{editAddress}</details>)}
    {target && !mustSetAddress && <>
      <div className="device-install">
        <h3>下载 Taktflow Link</h3>
        <p>在目标{platform === 'mac' ? ' Mac' : ' Linux 电脑'}上准备 Node.js 20.12 或更高版本，并安装、登录 Codex。</p>
        <a className="btn btn-sm" href={LINK_DOWNLOAD} download="taktflow-link.mjs"><Download aria-hidden /> 下载 Link 文件</a>
        <details open={platform === 'linux'}><summary>在目标电脑用终端下载</summary><CopyValue label="下载命令" value={linkDownloadCommand(target)} /></details>
      </div>
      <div className="device-install">
        <h3>从项目目录启动 Link</h3>
        <p>将文件存入目标电脑的 <code>~/Downloads</code>，在专用于此空间的项目目录打开终端并运行：</p>
        <CopyValue label="启动命令" value={linkCommand(target, spaceId, nodeId)} />
      </div>
      <div className="device-install">
        <h3>在终端提示时粘贴配对码</h3>
        <CopyValue label="一次性配对码" value={code} secret />
        <p>有效至 <DeviceTime value={expiresAt} />。完成后请保持 Link 运行。</p>
      </div>
    </>}
    {mustSetAddress && <p role="status">确认目标电脑访问地址后，即可查看下载与配对步骤。</p>}
  </div>
}

export function ConnectDialog({ open, pairing, connected, expired, error, busy, onClose, onLink }: {
  open: boolean; pairing?: Pairing; connected?: SpaceDevice; expired: boolean; error?: string; busy: boolean
  onClose: () => void; onLink: (computer: ComputerDetails) => void
}) {
  const [platform, setPlatform] = useState<ComputerDetails['platform']>('mac')
  const [name, setName] = useState('')
  useEffect(() => {
    if (!open) { setName(''); setPlatform('mac') }
  }, [open])
  const formId = useId()
  const result = useRef<HTMLHeadingElement>(null)
  const nameValid = !!name.trim() && !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)
  useEffect(() => { if (pairing || expired || connected) result.current?.focus() }, [pairing, expired, connected?.nodeId])
  const first = !pairing && !connected && !expired
  let content: ReactNode
  if (!open) content = null
  else if (connected) content = <div className="device-pairing" role="status">
    <h3 ref={result} tabIndex={-1}><CheckCircle2 aria-hidden /> {connected.displayName ?? connected.nodeId} 已配对</h3>
    <p>{connected.status === 'online' ? 'Codex 已在线，空间成员现在可以把开发任务交给这台电脑。' : '正在等待 Link 上线。上线后，空间成员即可把任务交给这台电脑。'}</p>
  </div>
  else if (pairing) content = <>
    <h3 className="device-pair-title" ref={result} tabIndex={-1}>连接「{pairing.displayName}」</h3>
    <InstallLink pairing={pairing} />
  </>
  else if (expired) content = <div className="device-pairing">
    <h3 ref={result} tabIndex={-1}>配对码已过期</h3>
    <p>关闭弹窗，重新添加电脑即可领取新配对码。</p>
  </div>
  else content = <form className="device-form" id={formId} onSubmit={event => {
    event.preventDefault()
    if (nameValid && !busy) onLink({ displayName: name.trim(), platform })
  }}>
    <fieldset className="device-platforms" disabled={busy}>
      <legend className="ov-field-label">这台电脑的系统</legend>
      <div className="device-platform-list">{(['mac', 'linux', 'windows'] as const).map(os =>
        <label key={os}>
          <input type="radio" name={formId + '-platform'} value={os} checked={platform === os} onChange={() => { if (os !== 'windows') setPlatform(os) }} disabled={os === 'windows'} />
          <span>{os === 'windows' ? 'Windows' : PLATFORM_LABEL[os]}</span>
        </label>)}</div>
      <p className="ov-field-hint">Windows 原生 Link 暂未提供。</p>
    </fieldset>
    <label className="ov-field">
      <span className="ov-field-label">电脑名称</span>
      <input data-autofocus className="input" type="text" maxLength={64} required value={name} onChange={e => setName(e.target.value)} disabled={busy}
        autoComplete="off" placeholder={platform === 'mac' ? '比如：我的 MacBook' : '比如：团队开发服务器'} />
      <span className="ov-field-hint">空间成员会看到这个名字，可以使用中文。</span>
    </label>
  </form>
  return <Dialog open={open} onClose={onClose} dismissible={false} className="device-dialog" title="添加电脑"
    footer={<><button type="button" className="btn" onClick={onClose}>{first ? '取消' : '关闭'}</button>
      {first && <button className="btn btn-primary" type="submit" form={formId} disabled={busy || !nameValid} aria-busy={busy}>下一步</button>}</>}>
    {content}
    {error && <p className="device-error" role="alert">{error}</p>}
  </Dialog>
}
