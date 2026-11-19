import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Laptop, Plus, RotateCw } from 'lucide-react'
import { useAsync, useSource, type SpaceDevice } from '../../api/index.js'
import type { ComputerDetails } from '../../api/devices.js'
import { useCrumbs } from '../../components/layout.js'
import { Dialog, EmptyState, PageHeader, Skeleton, SkeletonRows } from '../../components/ui.js'
import { actingUserHeader, setActingUser, subscribeActingUser } from '../../lib/acting-user.js'
import { Link, useLocation } from '../../lib/router.js'
import { splitSpace } from '../../lib/space.js'
import { ConnectDialog, DeviceTime, type Pairing } from './connect-dialog.js'
import { authDenied, canManageDevices, deviceError, DEVICE_ID, hubAddress, PLATFORM_LABEL, ROLE_LABELS } from './model.js'
import { REQUEST_MS, useDevices } from './use-devices.js'
import './devices.css'

const TITLE = '设备与 Agent'
const STATUS: Record<SpaceDevice['status'], string> = { online: '在线', offline: '离线', pending: '待配对' }
const explicitUser = (spaceId?: string) => actingUserHeader(false, spaceId)['x-takt-user']

export function DevicesPage() {
  const { spaceId } = useLocation()
  const user = useSyncExternalStore(subscribeActingUser, () => explicitUser(spaceId))
  useCrumbs([{ label: TITLE }], [])
  return <DevicesSession key={JSON.stringify([spaceId, user])} spaceId={spaceId} user={user} />
}

function DevicesSession({ spaceId, user }: { spaceId?: string; user?: string }) {
  const root = useSource()
  const source = spaceId ? root.forSpace(spaceId) : root
  const isCurrent = useCallback(() => {
    const scope = splitSpace(location.pathname)
    return scope.rest === '/devices' && scope.spaceId === spaceId && explicitUser(spaceId) === user
  }, [spaceId, user])
  const { data, error, loading, refresh } = useDevices(source, spaceId, isCurrent)
  const viewer = useAsync(() => source.me(), [spaceId, user])
  const [dialog, setDialog] = useState<'link' | SpaceDevice>()
  const [pairing, setPairing] = useState<Pairing>()
  const [pairedNode, setPairedNode] = useState<string>()
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState<string>()
  const [revoked, setRevoked] = useState<string>()
  const request = useRef<AbortController | undefined>(undefined)

  const me = viewer.error ? undefined : viewer.data
  const isOwner = me?.member?.role === 'owner'
  const canManage = canManageDevices(me, user, source.mock) && !!data
  const hub = hubAddress(location.origin)
  const closing = useCallback(() => {
    request.current?.abort()
    request.current = undefined
    setBusy(false)
    setDialog(undefined)
    setPairing(undefined)
    setExpired(false)
    setPairedNode(undefined)
    setWriteError(undefined)
  }, [])

  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => { if (!canManage) closing() }, [canManage, closing])
  useEffect(() => {
    if (!pairing) return
    const timer = window.setTimeout(() => {
      setPairing(undefined)
      setExpired(true)
      void refresh()
    }, Math.max(0, Date.parse(pairing.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [pairing, refresh])

  const write = async <T,>(operation: 'link' | 'revoke', send: (signal: AbortSignal) => Promise<T>, success: (value: T) => void) => {
    if (!canManage || !isCurrent() || request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setWriteError(undefined)
    setRevoked(undefined)
    try {
      const value = await send(AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_MS)]))
      if (controller.signal.aborted || !isCurrent()) return
      success(value)
      void refresh(true)
    } catch (error) {
      if (controller.signal.aborted || !isCurrent()) return
      setWriteError(deviceError(error, operation))
      if (authDenied(error)) viewer.reload()
    } finally {
      if (request.current === controller) {
        request.current = undefined
        if (isCurrent()) setBusy(false)
      }
    }
  }

  const link = (computer: ComputerDetails) => {
    if (!data) return
    void write('link', (signal) => source.createDeviceLink(computer, signal), (value) => {
      if (!DEVICE_ID.test(value.nodeId ?? '') || value.displayName !== computer.displayName || value.platform !== computer.platform || value.harness !== 'codex' || !value.code || !(Date.parse(value.expiresAt) > Date.now())) {
        setWriteError('Hub 未返回有效的配对码。请刷新设备列表，检查是否已登记，再重试。')
        return
      }
      setPairing({ ...value, ...computer, hub, spaceId: data.spaceId })
      setPairedNode(value.nodeId)
    })
  }
  const connected = data?.devices.find(device => device.nodeId === pairedNode && device.status !== 'pending')
  useEffect(() => {
    if (connected) { setPairing(undefined); setExpired(false) }
  }, [connected])
  const revokeTarget = dialog && dialog !== 'link' ? dialog : undefined
  const revoke = (device: SpaceDevice) => void write('revoke', (signal) => source.revokeDevice(device.nodeId, signal), () => {
    closing()
    setRevoked(device.displayName ?? device.nodeId)
  })
  const refreshPage = () => { void refresh(); viewer.reload() }

  return (
    <div className="page devices-page">
      <PageHeader title={TITLE} description="管理空间可调度的电脑与 Agent。" actions={<>
        <button type="button" className="btn" onClick={refreshPage} disabled={loading}><RotateCw aria-hidden /> 刷新</button>
        {canManage && <button type="button" className="btn btn-primary" onClick={() => { setRevoked(undefined); setDialog('link') }}><Plus aria-hidden /> 添加电脑</button>}
      </>} />

      <dl className="device-context">
        <div><dt>Hub 地址</dt><dd><code>{hub}</code></dd></div>
        <div><dt>当前空间</dt><dd>{data || spaceId ? <code>{data?.spaceId ?? spaceId}</code> : '默认空间'}</dd></div>
        <div><dt>当前身份</dt><dd>{viewer.error ? '无法确认' : me ? <>{me.name} <span className="device-meta">{me.member ? ROLE_LABELS[me.member.role] : '非空间成员'}</span></> : <span role="status" aria-label="正在确认身份"><Skeleton w={100} /></span>}</dd></div>
      </dl>

      <div className="device-access">
        {source.mock ? <p>演示数据只读；连上真实 Hub 后可管理设备。</p>
          : viewer.error ? <p role="alert">无法确认空间身份，请刷新后重试。</p>
          : me && !isOwner ? <p>连接和撤销设备仅限空间 Owner。如果需要接入设备，请联系此空间的所有者。</p>
          : isOwner && !canManage && <>
            <p>管理配对需要 Hub 确认 Owner 身份。本机开发模式可在这里选择。</p>
            {me.id === 'web' ? <Link to="/settings?tab=members" className="btn btn-sm">前往空间设置登记 Owner</Link>
              : !user && /^[\x21-\x7e]+$/.test(me.id) ? <button type="button" className="btn btn-sm" onClick={() => setActingUser(me.id)}>确认以 {me.name} 身份管理</button>
                : <Link to="/attention" className="btn btn-sm">前往待办选择「我是」</Link>}
          </>}
      </div>

      <details className="card device-protocol">
        <summary>接入自有 Agent</summary>
        <p>已有 Agent 服务可以实现 Worker 协议，由 Hub 管理员通过 <code>TAKT_TEAM_NODES</code> 登记空间、节点和 harness。接入后会显示在下方，可在空间管家的「直接开发」中选择。</p>
        <a href="https://github.com/Wayzinx/taktflow/blob/main/examples/team-delivery/README.md#接入已有的-agent-进程" target="_blank" rel="noreferrer">查看 Worker 协议和接入步骤</a>
      </details>

      <section className="card devices-inventory" aria-labelledby="device-inventory-title">
        <header className="device-inventory-head"><h2 id="device-inventory-title">执行设备</h2>{data && !error && <span className="device-meta">{data.devices.length} 台设备</span>}</header>
        {error && (user || !isOwner || data) && <p className="device-error device-load-error" role="alert">{data ? '刷新失败，列表为上次读取的状态。' : '无法读取设备列表。'}{error}</p>}
        {revoked && <p className="device-revoked" role="status">已撤销 <code>{revoked}</code> 的连接。</p>}
        {data?.devices.length ? <ul className="device-list">{data.devices.map((device) => <li key={device.nodeId}>
          <div className="device-main">
            <strong>{device.displayName ?? device.nodeId}</strong>
            <span className="device-meta">{device.platform && <>{PLATFORM_LABEL[device.platform]} · </>}Agent：{device.harness === 'codex' ? 'Codex' : device.harness} · {device.source === 'env' ? '环境变量管理' : '配对接入'}</span>
            {device.jobId && <span className="device-meta">任务：<code>{device.jobId}</code></span>}
            {device.lastSeenAt && <span className="device-meta">最后在线：<DeviceTime value={device.lastSeenAt} /></span>}
            {device.status === 'pending' && device.expiresAt && <span className="device-meta">配对截止：<DeviceTime value={device.expiresAt} /></span>}
          </div>
          <div className="device-row-actions">
            <span className="device-status" data-status={device.status}>{STATUS[device.status]}</span>
            {canManage && device.source === 'link' && <button type="button" className="btn btn-sm" aria-label={`撤销设备 ${device.displayName ?? device.nodeId} 的连接`} onClick={() => setDialog(device)}>撤销连接</button>}
          </div>
        </li>)}</ul>
          : !error && (data ? <EmptyState compact title="还没有连接设备" body={canManage ? '点击「添加电脑」，连接第一台 Mac 或 Linux 服务器。' : '设备接入后会出现在这里。'} />
            : loading && <div className="device-loading" role="status" aria-label="正在读取设备"><SkeletonRows rows={3} /></div>)}
      </section>
      <p className="device-note"><Laptop aria-hidden /> 环境变量管理的设备须由 Hub 管理员修改服务配置，不能在本页撤销。</p>

      <ConnectDialog open={canManage && dialog === 'link'} connected={connected} pairing={pairing} expired={expired} error={writeError} busy={busy} onClose={closing} onLink={link} />
      <Dialog open={canManage && !!revokeTarget} onClose={closing} dismissible={false} className="device-dialog" title="撤销设备连接？" tone="danger" size="sm"
        footer={<><button type="button" className="btn" onClick={closing}>取消</button><button type="button" className="btn btn-danger" disabled={busy || !revokeTarget} aria-busy={busy}
          onClick={() => { if (revokeTarget) revoke(revokeTarget) }}>撤销连接</button></>}>
        {revokeTarget && <p className="device-confirm">设备 <strong>{revokeTarget.displayName ?? revokeTarget.nodeId}</strong> 将不能再连接此空间；重新接入需要新的配对码。</p>}
        {revokeTarget && writeError && <p className="device-error" role="alert">{writeError}</p>}
      </Dialog>
    </div>
  )
}
