import { useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, ArrowRight, House, Minus, ServerOff, TriangleAlert } from 'lucide-react'
import type { HarnessInfo, ModelInfo, PairingInfo, ProviderProtocol, RuntimeTestResult } from '@taktflow/core'
import { useAsync } from '../../../api'
import { EmptyState, ErrorState, Popover, Skeleton } from '../../../components/ui'
import { PROTOCOL_SHORT, TestButton, TestOutcome, type RuntimeApi } from './shared'
import { BrandIcon } from '../../../components/brand/brand-icon'
import { harnessMeta } from '../../../lib/harness-meta'
import { useAccess } from '../access'
import './pairing.css'

type Status = PairingInfo['status']

export const PAIRING_STATUS: Record<Status, { label: string; icon: typeof House; hint: string }> = {
  builtin: { label: '自带', icon: House, hint: '用 Harness 自己的登录和默认模型' },
  direct: { label: '直连', icon: ArrowRight, hint: '协议对得上，Harness 直接调这家 API' },
  bridge: { label: '桥接', icon: ArrowLeftRight, hint: '协议对不上，由 takt 内置的协议桥自动转换' },
  unavailable: { label: '不可用', icon: Minus, hint: '这个组合跑不起来' },
}

/** "Codex（Responses）→ 协议桥 → DeepSeek（Chat）"：一格搭配的完整链路。 */
export function PairingPath({ p, harness, provider }: { p: PairingInfo; harness: string; provider?: string }) {
  const side = (name: string, protocol?: ProviderProtocol) => (
    <span className="pm-node">
      <b>{name}</b>
      {protocol && <span className="pm-proto">{PROTOCOL_SHORT[protocol]}</span>}
    </span>
  )
  if (p.status === 'builtin') return <span className="pm-path">{side(harness)}<ArrowRight aria-hidden />自带登录与模型</span>
  if (p.status === 'unavailable') return null
  return (
    <span className="pm-path">
      {side(harness, p.protocol)}
      <ArrowRight aria-hidden />
      {p.status === 'bridge' && (
        <>
          <span className="pm-bridge">协议桥</span>
          <ArrowRight aria-hidden />
        </>
      )}
      {side(provider ?? p.provider ?? '', p.status === 'bridge' ? p.upstream : p.protocol)}
    </span>
  )
}

function Cell({ p, harness, models, keyMissing }: { p: PairingInfo; harness: HarnessInfo; models: ModelInfo[]; keyMissing?: string }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState(models[0]?.alias)
  const [result, setResult] = useState<RuntimeTestResult>()
  const can = useAccess('owner', '测试搭配').ok
  // Harness 本身可用、只是自带账号没就绪（如 DeepSeek 没登录）：和上面 harness 列表的「可用」不矛盾，单独说
  const ownPending = p.status === 'unavailable' && p.provider === null && harness.available && harness.ownReady === false
  const meta = ownPending ? { ...PAIRING_STATUS.unavailable, label: '未就绪', hint: harness.ownReason ?? '自带账号未就绪' } : PAIRING_STATUS[p.status]
  const Icon = meta.icon
  const usable = p.status !== 'unavailable'
  const needsModel = p.provider !== null
  return (
    <td className="pm-td">
      <button
        ref={btn}
        type="button"
        className={`pm-cell is-${p.status}${keyMissing && usable ? ' no-key' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${harnessMeta(harness).name} × ${p.provider ?? '自带'}：${meta.label}`}
        onClick={() => setOpen(true)}
      >
        <Icon aria-hidden />
        <span>{meta.label}</span>
        {keyMissing && usable && <TriangleAlert className="pm-warn" aria-hidden />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} placement="bottom-start" className="pm-pop" role="dialog" ariaLabel={`${harnessMeta(harness).name} × ${p.provider ?? '自带'}`}>
        <div className="pm-pop-body">
          <div className="pm-pop-head">
            <b>
              {harnessMeta(harness).name} × {p.provider ?? '自带'}
            </b>
            <span className={`pm-tag is-${p.status}`}>
              <Icon aria-hidden />
              {meta.label}
            </span>
          </div>
          <PairingPath p={p} harness={harnessMeta(harness).name} />
          <p className="pm-pop-note">{ownPending ? `${harness.ownReason ?? '自带账号未就绪'}：Harness 本身可用，接下面的模型 API 不受影响；就绪后（例如登录账号）自带这一格就能用。` : p.status === 'unavailable' ? p.reason : p.status === 'bridge' ? `${meta.hint}；${(p.reason ?? '').replace(/^经协议桥转换[；;]?/, '') || '托管工具不可用'}。` : meta.hint}</p>
          {keyMissing && usable && (
            <p className="pm-pop-warn">
              <TriangleAlert aria-hidden />
              缺少密钥 <span className="mono">{keyMissing}</span>：在下面的 provider 里存到本机密钥库，或在启动 serve 的终端里设置。
            </p>
          )}
          {usable && can && (
            <div className="pm-pop-test">
              {needsModel &&
                (models.length ? (
                  <select className="select mono pm-model" value={model} onChange={(e) => setModel(e.target.value)} aria-label="测试用的模型">
                    {models.map((m) => (
                      <option key={m.alias} value={m.alias}>
                        {m.alias} · {m.id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="faint">这个 provider 还没有模型别名，先在下面的模型表里加一个。</span>
                ))}
              {(!needsModel || model) && <TestButton target={{ kind: 'pairing', harness: harness.id, provider: p.provider ?? undefined, model: needsModel ? model : undefined }} onResult={(r) => r && setResult(r)} label="测试这个组合" />}
            </div>
          )}
          {result && <TestOutcome r={result} />}
        </div>
      </Popover>
    </td>
  )
}

/**
 * 搭配矩阵（docs/design/31 §6）：行是「自带」和每个 provider，列是能用的 Harness。
 * 每格标自带 / 直连 / 桥接 / 不可用；点开看链路、原因，能用的可以真跑一次测试（计费，先确认）。
 */
export function PairingMatrix({ rt, harnesses, models }: { rt: RuntimeApi; harnesses?: HarnessInfo[]; models?: ModelInfo[] }) {
  const q = useAsync((ds) => ds.pairings(), [rt.cfg?.revision])
  const cols = useMemo(() => (harnesses ?? []).filter((h) => h.available && !h.override?.disabled), [harnesses])
  const providers = Object.entries(rt.cfg?.providers ?? {})
  const at = useMemo(() => new Map((q.data ?? []).map((p) => [`${p.harness}|${p.provider ?? ''}`, p])), [q.data])
  const hidden = (harnesses ?? []).length - cols.length
  // provider 实际提供的入口（主协议 + 预设登记的其他入口）：从搭配结果里反推，配置里只写了主协议
  const offered = (provider: string, main: ProviderProtocol): ProviderProtocol[] => {
    const seen = new Set<ProviderProtocol>([main])
    for (const p of q.data ?? []) if (p.provider === provider) for (const x of [p.status === 'direct' ? p.protocol : p.status === 'bridge' ? p.upstream : undefined]) if (x) seen.add(x)
    return [...seen]
  }

  const head = (
    <div className="section-head">
      <h2 className="section-title">搭配</h2>
      <span className="faint">Harness × 模型 API</span>
      <span className="spacer" />
      <span className="pm-legend" aria-label="图例">
        {(['builtin', 'direct', 'bridge', 'unavailable'] as Status[]).map((s) => {
          const Icon = PAIRING_STATUS[s].icon
          return (
            <span key={s} className={`is-${s}`} title={PAIRING_STATUS[s].hint}>
              <Icon aria-hidden />
              {PAIRING_STATUS[s].label}
            </span>
          )
        })}
      </span>
    </div>
  )
  if (q.error && !q.data)
    return (
      <>
        {head}
        <div className="card">
          <ErrorState error={q.error} onRetry={q.reload} />
        </div>
      </>
    )
  if (!q.data || !harnesses || !rt.cfg)
    return (
      <>
        {head}
        <div className="card pm-card">
          <Skeleton h={180} />
        </div>
      </>
    )

  if (!cols.length)
    return (
      <>
        {head}
        <div className="card">
          <EmptyState compact icon={ServerOff} title="还没有可用的 Harness" body="上面的 Harness 都没装好或已停用；装好一个（Claude Code、Codex、TRAE CLI、Pi），这里就会列出它能接哪些模型 API。" />
        </div>
      </>
    )

  const row = (provider: string | null) =>
    cols.map((h) => {
      const p = at.get(`${h.id}|${provider ?? ''}`)
      if (!p) return <td key={h.id} className="pm-td" />
      const env = provider ? rt.cfg!.providers[provider]?.apiKeyEnv : undefined
      const keyMissing = env && rt.cfg!.keys[env] === 'missing' ? env : undefined
      return <Cell key={h.id} p={p} harness={h} models={(models ?? []).filter((m) => m.provider === provider && m.kind !== 'embedding')} keyMissing={keyMissing} />
    })

  return (
    <>
      {head}
      <p className="pm-intro">
        任一 Harness 都能接任一模型 API：协议对得上就<b>直连</b>，对不上由 takt 内置的协议桥<b>桥接</b>，不用另起网关、不改 Harness 的全局配置。角色和节点里选「Harness + 模型」时按这里的结果走。
      </p>
      <div className="card pm-card">
        <div className="pm-scroll">
          <table className="pm-table">
            <thead>
              <tr>
                <th className="pm-corner">模型 API</th>
                {cols.map((h) => (
                  <th key={h.id} className="pm-col" title={h.capabilities.providerProtocols?.length ? `能直接说：${h.capabilities.providerProtocols.map((x) => PROTOCOL_SHORT[x]).join(' / ')}` : '只能用自带模型'}>
                    <span className="pm-col-name">
                      <BrandIcon k={harnessMeta(h).icon} label={harnessMeta(h).name} size={14} />
                      {harnessMeta(h).name}
                    </span>
                    <span className="pm-col-sub">{h.capabilities.customProvider ? (h.capabilities.providerProtocols ?? []).map((x) => PROTOCOL_SHORT[x]).join(' · ') : '只用自带'}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="pm-builtin">
                <th scope="row" className="pm-row">
                  <span className="pm-row-name">自带</span>
                  <span className="pm-row-sub">Harness 自己的登录和默认模型</span>
                </th>
                {row(null)}
              </tr>
              {providers.map(([id, p]) => (
                <tr key={id}>
                  <th scope="row" className="pm-row">
                    <span className="pm-row-name mono">{id}</span>
                    <span className="pm-row-sub">{offered(id, p.protocol).map((x) => PROTOCOL_SHORT[x]).join(' · ')}</span>
                  </th>
                  {row(id)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(hidden > 0 || providers.length === 0) && (
          <p className="pm-foot faint">
            {providers.length === 0 ? '还没有 provider：在下面加一家模型 API，这里就会列出每个 Harness 能不能接。' : ''}
            {hidden > 0 ? `${hidden} 个不可用或已停用的 Harness 没有列出。` : ''}
          </p>
        )}
      </div>
    </>
  )
}
