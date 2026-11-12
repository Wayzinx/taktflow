import type { SpaceCreateRequest, SpaceMember, SpaceSummary, SpaceTemplate } from '@taktflow/core'

/** 空间色：与 tokens.css 的分类色（--c-1…--c-8 浅色值）+ 品牌橙一致；存成颜色值，切换器与卡片直接用。 */
export const SPACE_COLORS = [
  { id: 'orange', label: '橙', value: 'oklch(0.62 0.17 47)' },
  { id: 'blue', label: '蓝', value: 'oklch(0.55 0.12 255)' },
  { id: 'teal', label: '青', value: 'oklch(0.58 0.09 205)' },
  { id: 'green', label: '绿', value: 'oklch(0.58 0.11 155)' },
  { id: 'amber', label: '琥珀', value: 'oklch(0.66 0.13 78)' },
  { id: 'rose', label: '玫红', value: 'oklch(0.58 0.14 355)' },
  { id: 'violet', label: '紫', value: 'oklch(0.54 0.12 300)' },
  { id: 'stone', label: '石灰', value: 'oklch(0.56 0.012 75)' },
] as const

export type CopyPart = Extract<SpaceTemplate, { copyFrom: string }>['parts'][number]
export const COPY_PARTS: Array<{ id: CopyPart; label: string; hint: string; on: boolean }> = [
  { id: 'agents', label: '角色', hint: '角色档案与默认模型', on: true },
  { id: 'skills', label: '技能', hint: '技能包与配方', on: true },
  { id: 'workflows', label: 'workflow', hint: '流水线定义', on: true },
  { id: 'knowledge', label: '知识库绑定', hint: '只复制绑定，不复制数据', on: true },
  { id: 'models', label: '模型设置', hint: 'harness 与预算默认值', on: true },
  { id: 'members', label: '成员', hint: '连同权限角色', on: false },
]

export type StartKind = 'blank' | 'standard' | 'quick' | 'copy'

export interface RepoRow {
  key: number
  loc: string
  branch: string
}
export interface MemberRow {
  key: number
  name: string
  email: string
  role: SpaceMember['role']
}

export interface SpaceForm {
  name: string
  id: string
  idTouched: boolean
  description: string
  color: string
  start: StartKind
  copyFrom?: string
  parts: CopyPart[]
  repos: RepoRow[]
  members: MemberRow[]
}

export const initialForm = (copyFrom?: string, n = 0): SpaceForm => ({
  name: '',
  id: '',
  idTouched: false,
  description: '',
  color: SPACE_COLORS[n % SPACE_COLORS.length]!.value,
  start: copyFrom ? 'copy' : 'standard',
  copyFrom,
  parts: COPY_PARTS.filter((p) => p.on).map((p) => p.id),
  repos: [],
  members: [],
})

export const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/

/** 名称 → id：ASCII 部分转小写短横线；纯中文名称取不到时给 space-<n>，等用户改。 */
export function slugify(name: string, taken: Set<string>): string {
  let base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
  if (base.length < 2) base = 'space'
  if (!taken.has(base) && (base !== 'space' || !name.trim())) return base
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${Date.now() % 1000}`
}

export interface Check {
  ok: boolean
  msg?: string
}
export function checkId(id: string, all: SpaceSummary[]): Check {
  if (!id) return { ok: false, msg: '填一个 id，用作目录名和网址' }
  if (!ID_RE.test(id)) return { ok: false, msg: '只能用小写字母、数字和 -，以字母或数字开头，2–40 个字符' }
  const hit = all.find((s) => s.id === id)
  if (hit) return { ok: false, msg: hit.archived ? `已归档的空间「${hit.name}」占用了这个 id` : `「${hit.name}」已经在用这个 id` }
  return { ok: true, msg: '可以使用' }
}
export function checkName(name: string, live: SpaceSummary[]): Check {
  if (!name.trim()) return { ok: false }
  if (live.some((s) => s.name === name.trim())) return { ok: false, msg: '已有同名空间，换个名字，免得切换时分不清' }
  return { ok: true }
}

const isUrl = (s: string) => /^(https?:\/\/|git@|ssh:\/\/)/.test(s)
const repoId = (loc: string) => loc.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ?? 'repo'

/**
 * creator：对话框里显示为"owner · 创建者"的当前用户（GET /api/me）。显式放进 members：
 * 没选"我是"时请求不带身份头，服务端把 members 里的第一个 owner 当作创建者（space-admin createSpace），
 * 新空间的成员就是向导里看到的这些，不会多出别人。复制来源空间成员且没填成员时不加，保留服务端的复制。
 */
export function toRequest(f: SpaceForm, creator?: { id: string; name: string }): SpaceCreateRequest {
  const template: SpaceTemplate = f.start === 'copy' && f.copyFrom ? { copyFrom: f.copyFrom, parts: f.parts } : f.start === 'copy' ? 'blank' : f.start
  const repos = f.repos.filter((r) => r.loc.trim()).map((r) => ({ id: repoId(r.loc.trim()), ...(isUrl(r.loc.trim()) ? { url: r.loc.trim() } : { path: r.loc.trim() }), defaultBranch: r.branch.trim() || 'main' }))
  const members: SpaceMember[] = f.members
    .filter((m) => m.name.trim())
    .map((m) => ({ id: (m.email.split('@')[0] || m.name).trim().toLowerCase().replace(/\s+/g, '-'), name: m.name.trim(), role: m.role, ...(m.email.trim() ? { email: m.email.trim() } : {}) }))
  const copiesMembers = typeof template === 'object' && template.parts.includes('members') && !members.length
  if (creator && !copiesMembers && !members.some((m) => m.id === creator.id)) members.unshift({ id: creator.id, name: creator.name, role: 'owner' })
  return {
    id: f.id,
    name: f.name.trim(),
    description: f.description.trim() || undefined,
    color: f.color,
    template,
    repos: repos.length ? repos : undefined,
    members: members.length ? members : undefined,
    reason: '网页新建空间',
  }
}
