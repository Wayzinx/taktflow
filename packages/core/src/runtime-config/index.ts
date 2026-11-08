import { join } from 'node:path'
import type { RuntimeConfig, RuntimeConfigPatch, RuntimeSystemRole } from '../api.js'
import type { Actor, TaktConfig } from '../types.js'
import type { ProjectStores } from '../interfaces.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { secretStatus } from '../secrets/index.js'
import { auditKnowledge, knowledgeFileLock } from '../knowledge/support.js'
import { readJsonFile, writeFileAtomic } from '../store/fs-utils.js'
import { systemWrite } from '../engine/guard.js'
import { fields, invalid, object, RuntimeConfigError, validateRuntimeConfig, type RuntimeValidationOptions } from './validation.js'

export { RuntimeConfigError, validateRuntimeConfig }
export type { RuntimeValidationOptions }
const sections = ['providers', 'models', 'roles', 'system', 'harnesses', 'harnessOverrides'] as const
const systems = { lead: ['lead', 'harness'], route: ['route', 'harness'], steward: ['steward', 'harness'], learner: ['lessons', 'learner'] } as const

export function runtimeSections(config: TaktConfig) {
  const system: RuntimeConfig['system'] = {}
  for (const id of Object.keys(systems) as RuntimeSystemRole[]) {
    const [section, key] = systems[id]
    const selector = (config[section] as Record<string, unknown> | undefined)?.[key]
    if (selector !== undefined) system[id] = selector as NonNullable<RuntimeConfig['system']['lead']>
  }
  return { providers: config.providers ?? {}, models: config.models ?? {}, roles: config.roles ?? {}, system,
    harnesses: config.harnesses ?? [], harnessOverrides: config.harnessOverrides ?? {} }
}

export function runtimeRevision(config: TaktConfig): string { return sha256(canonicalJson(runtimeSections(config))) }

export function readRuntimeConfig(config: TaktConfig, presets: RuntimeConfig['presets'],
  resolveProvider: (id: string, value: NonNullable<TaktConfig['providers']>[string]) => NonNullable<TaktConfig['providers']>[string] = (_, value) => value): RuntimeConfig {
  const view = runtimeSections(config)
  const keys: RuntimeConfig['keys'] = {}
  for (const [id, raw] of Object.entries(view.providers)) {
    const name = resolveProvider(id, raw).apiKeyEnv
    if (name) keys[name] = secretStatus(name).source
  }
  return { ...structuredClone(view), revision: runtimeRevision(config), keys, presets }
}

export function applyRuntimePatch(config: TaktConfig, input: unknown, options: RuntimeValidationOptions): { config: TaktConfig; keys: string[]; reason: string } {
  if (!object(input)) invalid('patch', '必须是对象')
  fields(input, ['baseRevision', 'reason', ...sections], 'patch')
  if (typeof input.baseRevision !== 'string' || !input.baseRevision) invalid('baseRevision', '请先读取运行时配置版本')
  if (typeof input.reason !== 'string' || !input.reason.trim()) invalid('reason', '请填写修改原因')
  if (runtimeRevision(config) !== input.baseRevision) throw new RuntimeConfigError(409, '运行时配置已变化；请刷新后重新提交')
  const next = structuredClone(config)
  const keys: string[] = []
  for (const section of sections) {
    const patch = structuredClone(input[section])
    if (patch === undefined) continue
    if (!object(patch)) invalid(section, '必须是按键打补丁的对象')
    for (const [key, value] of Object.entries(patch)) {
      if (!key.trim() || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid(section, '键名不合法')
      if (value !== null && !object(value)) invalid(`${section}.${key}`, '必须是对象或 null')
      if (value !== null) {
        const original = section === 'harnesses' ? next.harnesses?.find(h => h.id === key)
          : section === 'system' ? undefined : next[section]?.[key]
        for (const field of ['headers', 'env']) {
          if (!object(value[field])) continue
          for (const [name, content] of Object.entries(value[field])) {
            const previous = (original as Record<string, unknown> | undefined)?.[field]
            if (content !== '[REDACTED]') {
              if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE)/i.test(name)
                && (!object(previous) || previous[name] !== content)) invalid(`${section}.${key}.${field}.${name}`, '密钥不能写入空间配置，请使用进程环境变量或本机密钥库')
              continue
            }
            if (!object(previous) || typeof previous[name] !== 'string') invalid(`${section}.${key}.${field}.${name}`, '遮盖值没有对应原值，请重新填写')
            // 克隆补丁，避免把旧明文写回调用方保存的请求对象。
            value[field] = { ...value[field] as Record<string, unknown>, [name]: previous[name] }
          }
        }
      }
      keys.push(`${section}.${key}`)
      if (section === 'system') {
        if (!Object.hasOwn(systems, key)) invalid(`system.${key}`, '系统角色不存在')
        const [target, field] = systems[key as RuntimeSystemRole]
        const segment = { ...next[target] } as Record<string, unknown>
        if (value === null) delete segment[field]
        else segment[field] = value
        next[target] = segment
      } else if (section === 'harnesses') {
        if (value !== null && value.id !== key) invalid(`harnesses.${key}.id`, '必须与补丁键一致')
        const entries = [...next.harnesses ?? []]
        const index = entries.findIndex(h => h.id === key)
        if (value === null) { if (index >= 0) entries.splice(index, 1) }
        else if (index >= 0) entries[index] = value as unknown as NonNullable<TaktConfig['harnesses']>[number]
        else entries.push(value as unknown as NonNullable<TaktConfig['harnesses']>[number])
        next.harnesses = entries
      } else {
        const entries = { ...next[section] } as Record<string, unknown>
        if (value === null) delete entries[key]
        else entries[key] = value
        Object.assign(next, { [section]: entries })
      }
    }
  }
  validateRuntimeConfig(next, options)
  return { config: next, keys, reason: input.reason }
}

export async function patchRuntimeConfig(stores: ProjectStores, input: RuntimeConfigPatch | unknown, actor: Actor,
  options: RuntimeValidationOptions & { prepare?: (config: TaktConfig) => Promise<() => void> }): Promise<TaktConfig> {
  const file = join(stores.projectDir, 'takt.config.json')
  // 与空间其他配置写入使用同一把锁，版本检查必须在锁内读盘后进行。
  return systemWrite(stores.projectDir, ['takt.config.json', 'takt.config.json.*.tmp', 'takt.config.json.lock', '.takt/space-events.jsonl*'], () => knowledgeFileLock(file, async () => {
    const previous = await readJsonFile<TaktConfig>(file) ?? stores.config
    const { config, keys, reason } = applyRuntimePatch(previous, input, options)
    const activate = await options.prepare?.(config)
    await auditKnowledge(stores, actor, reason, JSON.stringify(keys))
    await writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n')
    stores.config = config
    activate?.()
    return config
  }))
}
