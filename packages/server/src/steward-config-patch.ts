import { canonicalJson, mergeConfigPatch, patchedConfig, sha256, StewardError, type Actor, type ProjectStores } from '@taktflow/core'
import { changeConfig, members, patchConfig, repoBinding } from './space.js'
import { text } from './http.js'

/** 管家提案的基线与写入必须在同一把配置锁内核对，避免检查后队友保存成员时被覆盖。 */
export async function stewardConfigPatch(stores: ProjectStores, input: Record<string, unknown>, by: Actor, reason: string): Promise<unknown> {
  const patch = input.patch as Record<string, unknown>
  if (typeof input.baseHash !== 'string') return patchConfig(stores, patch, by, reason)
  const allowed = new Set(['project', 'members', 'repos', 'roles', 'models', 'providers', 'budget', 'lead', 'route', 'retry', 'lessons', 'steward', 'knowledgeDefaults', 'contextBudgetTokens', 'sandbox'])
  if (Object.keys(patch).some((key) => !allowed.has(key))) throw new StewardError(400, '配置包含不允许修改的键')
  if (patch.project !== undefined && (!patch.project || typeof patch.project !== 'object' || Array.isArray(patch.project) || Object.keys(patch.project).some((key) => !['name', 'description', 'color'].includes(key))))
    throw new StewardError(400, 'project 只能修改 name、description、color')
  const checkKeys = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new StewardError(400, '配置键不合法')
      checkKeys(child)
    }
  }
  checkKeys(patch)
  await changeConfig(stores, by, reason, 'config.patch', (config) => {
    if (sha256(canonicalJson(patchedConfig(config, patch))) !== input.baseHash)
      throw new StewardError(409, '空间配置已被修改，请基于最新配置重新生成提案')
    const next = mergeConfigPatch(config, patch) as ProjectStores['config']
    text(next.project?.name, 'project.name')
    for (const key of ['description', 'color'] as const) if (next.project[key] !== undefined) text(next.project[key], `project.${key}`, true)
    if (next.members !== undefined) next.members = members(next.members)
    if (next.repos !== undefined) {
      if (!Array.isArray(next.repos)) throw new StewardError(400, 'repos 必须是数组')
      next.repos = next.repos.map((value) => repoBinding(value as unknown as Record<string, unknown>))
      if (new Set(next.repos.map((repo) => repo.id)).size !== next.repos.length) throw new StewardError(400, '仓库 ID 重复')
    }
    for (const key of Object.keys(config)) delete (config as unknown as Record<string, unknown>)[key]
    Object.assign(config, next)
  })
  return stores.config
}
