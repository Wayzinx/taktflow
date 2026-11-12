import { canonicalJson } from '../util/hash.js'
import { redactSecrets } from './files.js'

/**
 * config.patch 提案（docs/design/22 §1.5）。patchConfig 对数组整体替换：管家照生成时的成员列表写一整组，
 * 待批期间别人加的成员会被覆盖掉。所以基线只取补丁碰到的那部分配置，批准时变了就 stale；
 * 预览按配置差异展示，带 id 的数组（成员、仓库）按 id 对齐，只列增删改的项，其余折叠成一句。
 */
type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)

/** 补丁碰到的那部分当前配置：补丁是对象就逐键往下取，否则整体取（数组、标量会被整体替换）。 */
export function patchedConfig(config: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return config ?? null
  const current = isObject(config) ? config : {}
  return Object.fromEntries(Object.keys(patch).map((key) => [key, patchedConfig(current[key], patch[key])]))
}

/** 与服务端 patchConfig 相同的合并：对象逐键合并，null 删掉这个键，数组和标量整体替换。 */
export function mergeConfigPatch(config: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch
  const result: Json = isObject(config) ? { ...config } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = mergeConfigPatch(result[key], value)
  }
  return result
}

const UNITS: Record<string, [string, string]> = { members: ['成员', '名'], repos: ['仓库', '个'] }
const keyed = (value: unknown): value is Json[] =>
  Array.isArray(value) && value.every((item) => isObject(item) && typeof item.id === 'string')
const brief = (value: unknown) => (typeof value === 'string' ? value : Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join('、') : JSON.stringify(value))
/** 按键名脱敏后再显示：比较用原值，否则改了密钥两边都是 *** 会被当成没变。 */
const shown = (key: string, value: unknown) => brief((redactSecrets({ [key]: value }) as Json)[key])
/** 一项的人话：id 打头，其余字段按值列出（name 与 id 相同时不重复）。 */
const itemLine = (item: Json) =>
  [String(item.id), ...Object.entries(item).filter(([key, value]) => key !== 'id' && !(key === 'name' && value === item.id)).map(([key, value]) => shown(key, value))].join(' · ')

function describe(path: string[], before: unknown, after: unknown, patch: unknown, out: string[]): void {
  if (isObject(patch) && isObject(after)) {
    for (const key of Object.keys(patch)) describe([...path, key], isObject(before) ? before[key] : undefined, after[key], patch[key], out)
    return
  }
  if (same(before, after)) return
  const name = path.join('.')
  if (keyed(after) && (before === undefined || keyed(before))) {
    const unit = UNITS[name]
    const old = new Map((before ?? []).map((item) => [item.id, item]))
    const next = new Set(after.map((item) => item.id))
    out.push(`@@ ${unit ? `${unit[0]}（${name}）` : name} @@`)
    let kept = 0
    for (const item of after) {
      const prev = old.get(item.id)
      if (!prev) out.push(`+ ${itemLine(item)}`)
      else if (!same(prev, item)) out.push(`- ${itemLine(prev)}`, `+ ${itemLine(item)}`)
      else kept++
    }
    for (const item of before ?? []) if (!next.has(item.id)) out.push(`- ${itemLine(item)}`)
    if (kept) out.push(`  另外 ${kept} ${unit ? `${unit[1]}${unit[0]}` : '项'}不变`)
    return
  }
  if (before !== undefined) out.push(`- ${name}：${shown(path.at(-1)!, before)}`)
  if (after !== undefined) out.push(`+ ${name}：${shown(path.at(-1)!, after)}`)
}

/** 预览：补丁相对当前配置改了什么（密钥脱敏）；没有任何变化时返回空串。 */
export function configPatchPreview(config: unknown, patch: unknown): string {
  const out: string[] = []
  describe([], config, mergeConfigPatch(config, patch), patch, out)
  return out.join('\n')
}
