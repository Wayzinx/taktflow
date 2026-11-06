import { useRef, useState, type KeyboardEvent } from 'react'
import { Eye } from 'lucide-react'
import type { RouteDecision, Tier } from '@taktflow/core'
import { useSource } from '../api'
import type { PresenceState } from '../lib/motion'
import { RouteFacts } from './route-card.facts'
import { TIER_LABEL, TierGlyph } from './tier-glyph'

const TIERS: Tier[] = ['T0', 'T1', 'T2', 'T3']

/**
 * 改档面板：选档位 + 写原因（必填，留痕）→ `ds.routePreview`（服务端把 tier / reason 转成命令 route.preview 的 override）。
 * 只预览路由器校验后的结果（可能被降档并写明原因），不启动、不改运行。
 */
export function RouteChange({ state, current, requirementId, onClose }: { state: PresenceState; current: RouteDecision; requirementId: string; onClose(): void }) {
  const ds = useSource()
  const [tier, setTier] = useState<Tier>(current.tier === 'T2' ? 'T1' : 'T2')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [preview, setPreview] = useState<RouteDecision>()
  const group = useRef<HTMLDivElement>(null)

  async function run() {
    if (!reason.trim() || busy) return
    setBusy(true)
    setError(undefined)
    try {
      setPreview(await ds.routePreview(requirementId, { tier, reason: reason.trim() }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 单选组的方向键：与原生 radio 一致
  function onKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = TIERS[(TIERS.indexOf(tier) + d + TIERS.length) % TIERS.length]!
    setTier(next)
    setPreview(undefined)
    group.current?.querySelector<HTMLButtonElement>(`[data-tier='${next}']`)?.focus()
  }

  const id = `route-change-${requirementId}`
  return (
    <div className="route-change" data-state={state} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="route-tiers" role="radiogroup" aria-label="改成哪个档位" ref={group} onKeyDown={onKey}>
        {TIERS.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={tier === t}
            tabIndex={tier === t ? 0 : -1}
            data-tier={t}
            className="route-tier-opt"
            disabled={t === current.tier}
            title={t === current.tier ? '当前档位' : TIER_LABEL[t].hint}
            onClick={() => {
              setTier(t)
              setPreview(undefined)
            }}
          >
            <TierGlyph tier={t} size={18} label={false} />
            <span className="mono">{t}</span>
            {t === current.tier && <span className="route-tier-now">当前</span>}
          </button>
        ))}
      </div>
      <label className="route-k" htmlFor={id}>
        改档原因（必填，会留痕）
      </label>
      <textarea
        id={id}
        className="textarea route-reason-input"
        rows={2}
        value={reason}
        placeholder={`例如：只动 ${current.surfaces[0]?.id ?? '一个模块'}，不需要完整评审`}
        onChange={(e) => {
          setReason(e.target.value)
          setError(undefined)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
        }}
      />
      {error && (
        <p className="route-error" role="alert">
          {error}
        </p>
      )}
      <div className="route-change-actions">
        <span className="faint">只预览路由器校验后的结果，不启动运行</span>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-sm btn-primary" disabled={!reason.trim() || busy} onClick={() => void run()}>
          <Eye />
          {busy ? '正在预览…' : `预览 ${tier}`}
        </button>
      </div>
      {preview && (
        <div className="route-preview" aria-live="polite">
          <span className="section-label">预览结果</span>
          {preview.tier !== tier && (
            <p className="route-downgrade">
              选的是 <span className="mono">{tier}</span>，校验后为 <span className="mono">{preview.tier}</span>
            </p>
          )}
          <RouteFacts route={preview} compact />
        </div>
      )}
    </div>
  )
}
