import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectStores } from '../interfaces.js'
import type { AgentRoleView } from '../api.js'
import { loadPlugins } from '../plugins/load.js'
import { parseRoleProfile } from './role-profile.js'

export interface RoleSource { markdown: string; path?: string; origin: AgentRoleView['origin'] }
export async function loadRoleSources(agentsDir: string, pluginRoles: Record<string, string>, warn?: (message: string) => void): Promise<Record<string, RoleSource>> {
  const sources: Record<string, RoleSource> = Object.create(null)
  const load = async (dir: string, origin: RoleSource['origin']) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const seen = new Set<string>()
    for (const entry of entries.filter(e => e.isFile() && e.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const path = join(dir, entry.name), markdown = await readFile(path, 'utf8')
        const role = parseRoleProfile(markdown, entry.name.slice(0, -3)).role
        if (seen.has(role)) throw new Error(`角色 ${role} 重复，请检查档案文件`)
        seen.add(role)
        sources[role] = { markdown, origin, ...(origin === 'space' ? { path } : {}) }
      } catch (error) {
        if (!warn || origin !== 'space') throw error
        warn(`跳过无法解析的角色 ${entry.name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  await load(join(dirname(fileURLToPath(import.meta.url)), '../../../../templates/agents'), 'builtin')
  for (const [role, markdown] of Object.entries(pluginRoles)) {
    if (parseRoleProfile(markdown, role).role !== role) throw new Error(`插件角色 ${role} 与 frontmatter role 不一致`)
    sources[role] = { markdown, origin: 'plugin' }
  }
  await load(agentsDir, 'space')
  return sources
}

export async function roleSources(stores: ProjectStores): Promise<Record<string, RoleSource>> {
  const plugins = await loadPlugins(stores.config, stores.projectDir, url => import(url))
  return loadRoleSources(stores.paths.agents, plugins.roles)
}

export function profilesFromSources(sources: Record<string, RoleSource>) {
  return Object.fromEntries(Object.entries(sources).map(([role, source]) => [role, parseRoleProfile(source.markdown, role)]))
}

export async function loadSpaceProfiles(stores: ProjectStores) {
  return profilesFromSources(await roleSources(stores))
}
