import type { AgentProfile, HarnessSelector } from '../types.js'
import { parseFrontmatter } from '../util/frontmatter.js'

// 协议要求运行时 profile.harness 有值；另记档案是否显式指定，避免默认 mock 遮住空间路由。
const inherited = new WeakSet<AgentProfile>()
export const explicitRoleHarness = (profile: AgentProfile): HarnessSelector | undefined => inherited.has(profile) ? undefined : profile.harness


function validateSelector(value: unknown, field: string, depth = 0): asserts value is HarnessSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 20) throw new Error(`${field} 必须是 harness 对象，fallback 最多 20 层，请修正档案`)
  const selector = value as Record<string, unknown>
  for (const key of Object.keys(selector)) if (!['harness', 'model', 'provider', 'effort', 'fallback'].includes(key)) throw new Error(`${field}.${key} 不支持，请删除该字段`)
  for (const key of ['harness', 'model', 'provider']) if (key === 'harness' || selector[key] !== undefined) {
    if (typeof selector[key] !== 'string' || !(selector[key] as string).trim()) throw new Error(`${field}.${key} 必须是非空字符串，请修正档案`)
  }
  if (selector.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(selector.effort))) throw new Error(`${field}.effort 不合法，请选择 low、medium、high、xhigh 或 max`)
  if (selector.fallback !== undefined) {
    if (!Array.isArray(selector.fallback)) throw new Error(`${field}.fallback 必须是数组，请修正档案`)
    selector.fallback.forEach((entry, i) => validateSelector(entry, `${field}.fallback.${i}`, depth + 1))
  }
}

export function parseRoleProfile(markdown: string, name: string): AgentProfile {
  const { data, body } = parseFrontmatter(markdown)
  const list = (key: string): string[] => {
    const value = data[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${name}：${key} 必须是字符串数组，请修正角色档案`)
    return value
  }
  const selector = typeof data.harness === 'string' ? { harness: data.harness } : data.harness
  if (selector !== undefined) validateSelector(selector, `${name}.harness`)
  if (data.allowBash !== undefined && typeof data.allowBash !== 'boolean') throw new Error(`${name}：allowBash 必须是 boolean，请修正角色档案`)
  const role = typeof data.role === 'string' && data.role ? data.role : name
  const profile: AgentProfile = {
    role, title: typeof data.title === 'string' && data.title ? data.title : role,
    description: typeof data.description === 'string' ? data.description : '',
    harness: (selector as HarnessSelector | undefined) ?? { harness: 'mock' },
    skills: list('skills'), writeScope: list('writeScope'), instructions: body.trim(),
    ...(data.readScope === undefined ? {} : { readScope: list('readScope') }),
    ...(data.knowledge === undefined ? {} : { knowledge: list('knowledge') }),
    ...(data.allowBash === undefined ? {} : { allowBash: data.allowBash as boolean }),
  }
  if (selector === undefined) inherited.add(profile)
  return profile
}
