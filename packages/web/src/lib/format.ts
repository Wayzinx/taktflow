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

/** 将来的时间点说成人话：今天 18:30 / 明天 09:30 / 周一 18:30 / 11-20 18:30。 */
export function fmtUpcoming(ts: string): string {
  const d = new Date(ts)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(d) - day(new Date())) / 86_400_000)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (days === 0) return `今天 ${hm}`
  if (days === 1) return `明天 ${hm}`
  if (days > 1 && days < 7) return `周${'日一二三四五六'[d.getDay()]} ${hm}`
  return fmtDate(ts)
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

const RUN_END: Record<string, string> = { succeeded: '成功', failed: '失败', cancelled: '已取消', waiting_human: '等人处理', running: '运行中' }
const VERDICT_WORD: Record<string, string> = {
  product_bug: '代码缺陷', case_defect: '用例缺陷', script_defect: '脚本缺陷', env_issue: '环境问题', flaky: '不稳定', requirement_gap: '需求缺口',
  test_data: '测试数据', deployment: '部署问题', permission: '权限问题', external_dependency: '外部依赖', unknown: '无法判定',
}

/** 把一段原始 JSON 说成人话；认不出的返回 undefined。 */
function jsonGist(raw: string): string | undefined {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return undefined }
  if (Array.isArray(value) && value.every((v) => v && typeof v === 'object' && 'subject' in v)) {
    const list = value as Array<{ subject: string; category?: string }>
    const head = list.slice(0, 3).map((v) => `${v.subject}（${VERDICT_WORD[v.category ?? ''] ?? v.category ?? '待定'}）`).join('、')
    return `${list.length} 条判决：${head}${list.length > 3 ? ' 等' : ''}`
  }
  if (!value || typeof value !== 'object') return undefined
  const o = value as Record<string, unknown>
  if (Array.isArray(o.records)) {
    const issues = (o.records as Array<{ issues?: unknown[] }>).reduce((n, r) => n + (Array.isArray(r.issues) ? r.issues.length : 0), 0)
    return `${typeof o.round === 'number' ? `第 ${o.round} 轮评审` : '评审'}：${o.records.length} 位评审提了 ${issues} 个问题`
  }
  const said = [o.result, o.message].find((v) => typeof v === 'string' && v.trim()) as string | undefined
  const kind = typeof o.subtype === 'string' && o.subtype !== 'success' ? o.subtype : undefined
  return [kind, said].filter(Boolean).join('：') || undefined
}

/**
 * 给人看的消息：系统消息、待办提问里夹着的原始 JSON 换成要点（判决、评审意见、harness 报错），
 * 运行结束的状态码换成中文。旧消息存的是原文，展示时整理；新消息在引擎里就写成人话。
 */
export function tidyText(text: string): string {
  let out = text.replace(/^运行结束：(\w+)$/, (all, status: string) => (RUN_END[status] ? `运行结束：${RUN_END[status]}` : all))
  const at = out.search(/[[{]/)
  if (at >= 0 && out.length - at > 60) {
    const gist = jsonGist(out.slice(at).trim())
    if (gist) out = `${out.slice(0, at).trimEnd()}${gist}`
  }
  return out
}

/** 长文本的一行摘要：换行并成空格，超长截断。待办提问、通知正文、悬停提示这类只看要点的地方用。 */
export function summaryLine(text: string, max = 140): string {
  const line = tidyText(text).replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export function plural(n: number, unit: string): string {
  return `${n} ${unit}`
}
