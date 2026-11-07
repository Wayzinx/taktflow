import type { ExternalLink, RunBudget } from '@taktflow/core'
import { currentSpaceId } from '../../lib/space'

/** 新建需求对话框里的全部可编辑内容（也是本地草稿的形状）。 */
export interface RequirementDraft {
  text: string
  /** 用户改过标题后不再跟随首行。 */
  title?: string
  workflowId?: string
  repos: string[]
  owner?: string
  members: string[]
  budget?: RunBudget
  dueAt?: string
  links: ExternalLink[]
  start: boolean
}

export interface Attachment {
  name: string
  size: number
  content: string
  encoding: 'utf8' | 'base64'
}

export const emptyDraft = (): RequirementDraft => ({ text: '', repos: [], members: [], links: [], start: true })

const key = () => `takt.reqDraft.${currentSpaceId() ?? 'default'}`

/** 草稿按空间存在浏览器本地；读写失败（隐私模式等）时静默忽略。 */
export function loadDraft(): RequirementDraft | undefined {
  try {
    const raw = localStorage.getItem(key())
    if (!raw) return undefined
    const d = { ...emptyDraft(), ...(JSON.parse(raw) as Partial<RequirementDraft>) }
    return hasContent(d) ? d : undefined
  } catch {
    return undefined
  }
}

export function saveDraft(d: RequirementDraft) {
  try {
    if (hasContent(d)) localStorage.setItem(key(), JSON.stringify(d))
    else localStorage.removeItem(key())
  } catch {
    /* 存不了就算了 */
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(key())
  } catch {
    /* ignore */
  }
}

export const hasContent = (d: RequirementDraft) => !!(d.text.trim() || d.title?.trim() || d.links.length || d.dueAt || d.budget)

/** 标题默认取首个非空行，去掉 Markdown 标题符号与列表符号。 */
export function titleOf(d: RequirementDraft): string {
  if (d.title !== undefined) return d.title.trim()
  const first = d.text.split('\n').find((l) => l.trim()) ?? ''
  return first.replace(/^\s*(#{1,6}|[-*>]|\d+[.)])\s*/, '').trim().slice(0, 120)
}

/** 链接类型从域名猜。 */
export function linkType(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()
  if (/meego|bytedance\.net\/.*story/.test(host + url)) return 'meego'
  if (/feishu|larksuite|larkoffice/.test(host)) return 'feishu'
  if (/github/.test(host)) return 'github'
  if (/jira|atlassian/.test(host)) return 'jira'
  return 'url'
}

export const LINK_LABEL: Record<string, string> = { meego: 'Meego', feishu: '飞书', github: 'GitHub', jira: 'Jira', url: '链接' }

const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|tsv|xml|html?|js|ts|tsx|py|sql|log)$/i
export const MAX_ATTACHMENT = 5 * 1024 * 1024

/** 文本文件按 utf8 读，其余按 base64。 */
export function readAttachment(file: File): Promise<Attachment> {
  const text = file.type.startsWith('text/') || TEXT_EXT.test(file.name) || file.type === 'application/json'
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error ?? new Error(`读取 ${file.name} 失败`))
    r.onload = () => {
      const v = String(r.result ?? '')
      resolve({ name: file.name, size: file.size, encoding: text ? 'utf8' : 'base64', content: text ? v : v.slice(v.indexOf(',') + 1) })
    }
    if (text) r.readAsText(file)
    else r.readAsDataURL(file)
  })
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 截止时间快捷项：今天 / 明天 / 本周五 / 下周五（都取当天 18:00）。 */
export function duePresets(now = new Date()): Array<{ label: string; at: string }> {
  const at = (d: Date) => {
    const x = new Date(d)
    x.setHours(18, 0, 0, 0)
    return x.toISOString()
  }
  const plus = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n)
  const toFri = (5 - now.getDay() + 7) % 7
  return [
    { label: '今天', at: at(plus(0)) },
    { label: '明天', at: at(plus(1)) },
    { label: '本周五', at: at(plus(toFri)) },
    { label: '下周五', at: at(plus(toFri + 7)) },
  ]
}

export function fmtDue(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  if (days === 0) return `今天 · ${md}`
  if (days === 1) return `明天 · ${md}`
  if (days < 0) return `已过 ${-days} 天 · ${md}`
  return `${days} 天后 · ${md}`
}

/** ISO ↔ <input type="date"> 的 yyyy-mm-dd（本地时区）。 */
export const toDateInput = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const fromDateInput = (v: string) => {
  if (!v) return undefined
  const [y, m, d] = v.split('-').map(Number)
  return new Date(y!, m! - 1, d!, 18).toISOString()
}

export function fmtBudget(b?: RunBudget): string | undefined {
  if (!b) return undefined
  const parts = [b.costUsd ? `$${b.costUsd}` : '', b.tokens ? `${Math.round(b.tokens / 10_000)} 万 tokens` : '', b.minutes ? `${b.minutes} 分钟` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

/**
 * 附件落到 inputs/<name>：服务端按 [\w.\-一-龥] 清洗文件名、不区分大小写去重，并且 prd.md 留给需求描述。
 * 提交前在这里按同样的规则改名（重名追加 -2、-3），避免拖入一份 prd.md 就整单 400。
 */
export function uniqueAttachmentNames(names: string[]): string[] {
  const used = new Set(['prd.md'])
  return names.map((raw) => {
    const clean = raw.replace(/[^\w.\-一-龥]/g, '').replace(/^\.+$/, '') || 'attachment'
    const dot = clean.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, '']
    let name = clean
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem}-${i}${ext}`
    used.add(name.toLowerCase())
    return name
  })
}
