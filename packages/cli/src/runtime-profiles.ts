import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontmatter, type AgentProfile, type HarnessSelector } from '@taktflow/core'

function profile(markdown: string, roleName: string, source: string): AgentProfile {
  const { data, body } = parseFrontmatter(markdown)
  const text = (key: string, fallback: string): string => {
    const value = data[key]
    return typeof value === 'string' && value !== '' ? value : fallback
  }
  const list = (key: string): string[] => {
    const value = data[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${source}: ${key} 必须是字符串数组`)
    return value as string[]
  }
  if (data.allowBash !== undefined && typeof data.allowBash !== 'boolean') throw new Error(`${source}: allowBash 必须是 boolean`)
  const harness = typeof data.harness === 'string' ? { harness: data.harness } : data.harness
  if (!harness || typeof harness !== 'object' || typeof (harness as HarnessSelector).harness !== 'string') throw new Error(`${source}: 缺少 harness`)
  const role = text('role', roleName)
  return {
    role, title: text('title', role), description: text('description', ''),
    harness: harness as HarnessSelector, skills: list('skills'), writeScope: list('writeScope'),
    ...(data.readScope === undefined ? {} : { readScope: list('readScope') }),
    instructions: body.trim(), allowBash: data.allowBash === true,
  }
}

export async function loadRuntimeProfiles(taktDir: string, roles: Record<string, string>): Promise<Record<string, AgentProfile>> {
  const result: Record<string, AgentProfile> = Object.create(null)
  const add = (value: AgentProfile) => {
    if (Object.hasOwn(result, value.role)) throw new Error(`角色名称冲突：${value.role}`)
    result[value.role] = value
  }
  for (const [role, markdown] of Object.entries(roles)) {
    const value = profile(markdown, role, `插件角色 ${role}`)
    if (value.role !== role) throw new Error(`插件角色 ${role} 与 frontmatter role 不一致`)
    add(value)
  }
  const dir = join(taktDir, 'agents')
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const file = join(dir, entry.name)
    add(profile(await readFile(file, 'utf8'), entry.name.slice(0, -3), file))
  }
  return result
}
