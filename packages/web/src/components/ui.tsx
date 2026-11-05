import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, type LucideIcon } from 'lucide-react'
import { TaktRuler } from './takt'
import type { NodeKind } from '@taktflow/core'
import { NODE_KIND, toneSoftVar, toneVar, type StatusMeta, type Tone } from '../lib/status'
import { initials } from '../lib/format'
import './ui.css'

export function StatusBadge({ meta, subtle }: { meta: StatusMeta; subtle?: boolean }) {
  const Icon = meta.icon
  return (
    <span className={`status-badge${subtle ? ' subtle' : ''}`} style={{ '--tone': meta.tone === 'pending' ? 'var(--text-2)' : toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties}>
      <Icon className={meta.spin ? 'spin' : undefined} strokeWidth={2.4} />
      {meta.label}
    </span>
  )
}

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={`status-dot${pulse ? ' pulse' : ''}`} style={{ '--tone': toneVar(tone) } as CSSProperties} />
}

export function KindIcon({ kind, size = 22 }: { kind: NodeKind; size?: number }) {
  const { icon: Icon, label } = NODE_KIND[kind]
  return (
    <span className={`kind-icon kind-${kind}`} style={{ width: size, height: size }} title={label}>
      <Icon strokeWidth={2} />
    </span>
  )
}

const AVATAR_HUES = [248, 190, 152, 32, 330, 270, 210]
export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const hue = AVATAR_HUES[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_HUES.length]
  // 小于 20px 放不下 11px 的字，只留色块，名字在 title / aria-label 里
  const tiny = size < 20
  return (
    <span className="avatar" title={name} aria-label={name} style={{ width: size, height: size, fontSize: tiny ? undefined : Math.max(11, size * 0.42), '--hue': hue } as CSSProperties}>
      {tiny ? null : initials(name)}
    </span>
  )
}

export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  return (
    <span className="avatar-stack">
      {names.slice(0, max).map((n) => (
        <Avatar key={n} name={n} />
      ))}
      {names.length > max && <span className="avatar more">+{names.length - max}</span>}
    </span>
  )
}

export function Skeleton({ w = '100%', h = 12, r, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <span className="skeleton" style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} />
}

export function SkeletonRows({ rows = 5, gap = 14 }: { rows?: number; gap?: number }) {
  return (
    <div style={{ display: 'grid', gap, padding: 16 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Skeleton w={22} h={22} r={6} />
          <Skeleton w={`${38 + ((i * 17) % 40)}%`} h={11} />
          <span style={{ flex: 1 }} />
          <Skeleton w={56} h={11} />
        </div>
      ))}
    </div>
  )
}

export function EmptyState({ icon: Icon, title, hint, action, compact }: { icon: LucideIcon; title: string; hint?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`}>
      <span className="empty-icon">
        <Icon strokeWidth={1.6} />
      </span>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div className="empty-action">{action}</div>}
      {!compact && <TaktRuler ticks={9} className="empty-ruler" />}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="加载失败"
      hint={<span className="mono">{error.message}</span>}
      action={onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          重试
        </button>
      )}
    />
  )
}

export interface TabDef {
  id: string
  label: string
  icon?: LucideIcon
  count?: number
  hidden?: boolean
}

export function Tabs({ tabs, value, onChange, size }: { tabs: TabDef[]; value: string; onChange: (id: string) => void; size?: 'sm' }) {
  return (
    <div className={`tabs${size === 'sm' ? ' tabs-sm' : ''}`} role="tablist">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => {
          const Icon = t.icon
          return (
            <button key={t.id} role="tab" aria-selected={t.id === value} className={`tab${t.id === value ? ' active' : ''}`} onClick={() => onChange(t.id)}>
              {Icon && <Icon />}
              {t.label}
              {t.count !== undefined && <span className="tab-count num">{t.count}</span>}
            </button>
          )
        })}
    </div>
  )
}

export function Segmented<T extends string>({ options, value, onChange }: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 进度条：一段或多段。 */
export function Meter({ value, tone = 'success', height = 6 }: { value: number; tone?: Tone; height?: number }) {
  return (
    <span className="meter" style={{ height }}>
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: toneVar(tone) }} />
    </span>
  )
}

// ---------------------------------------------------------------- toast

interface ToastItem {
  id: number
  title: string
  body?: ReactNode
  tone?: Tone
}
let toastId = 0
const toastSubs = new Set<(t: ToastItem) => void>()
export function toast(title: string, opts: { body?: ReactNode; tone?: Tone } = {}) {
  const t = { id: ++toastId, title, ...opts }
  toastSubs.forEach((f) => f(t))
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => {
    const add = (t: ToastItem) => {
      setItems((s) => [...s, t])
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== t.id)), 6000)
    }
    toastSubs.add(add)
    return () => {
      toastSubs.delete(add)
    }
  }, [])
  return (
    <div className="toaster">
      {items.map((t) => (
        <div key={t.id} className="toast fade-in" style={{ '--tone': toneVar(t.tone ?? 'success') } as CSSProperties}>
          <span className="toast-bar" />
          <div>
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
