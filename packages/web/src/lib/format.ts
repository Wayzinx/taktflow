import type { Actor, Usage } from '@taktflow/core'

export function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export const totalTokens = (u: Usage | undefined): number => (u ? u.inputTokens + u.outputTokens : 0)

export function fmtCost(usd: number | undefined): string {
  if (usd === undefined) return '—'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(usd >= 100 ? 0 : 2)}`
}

export function fmtPct(v: number | undefined, digits = 0): string {
  return v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function durationBetween(start?: string, end?: string): number | undefined {
  if (!start) return undefined
  return (end ? Date.parse(end) : Date.now()) - Date.parse(start)
}

export function fmtRelative(ts: string | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - Date.parse(ts)
  const min = Math.round(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.round(h / 24)
  return d < 30 ? `${d} 天前` : fmtDate(ts)
}

const pad = (n: number) => String(n).padStart(2, '0')

export function fmtDate(ts: string): string {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtTime(ts: string): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function actorName(a: Actor): string {
  if (a.type === 'human') return a.id
  if (a.type === 'agent') return `${a.role} · ${a.harness}`
  return a.id
}

export function initials(name: string): string {
  const clean = name.replace(/^ai:/, '')
  return /[一-龥]/.test(clean) ? clean.slice(-2) : clean.slice(0, 2).toUpperCase()
}

export function plural(n: number, unit: string): string {
  return `${n} ${unit}`
}
