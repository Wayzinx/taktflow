import type { CommandInfo } from '@taktflow/core'
import type { PaletteContext } from './items'

/** ⌘K 能生成表单的 JSON Schema 子集：object 下一层的 string / enum / number / integer / boolean。 */
export interface FieldSpec {
  key: string
  title: string
  type: 'string' | 'enum' | 'number' | 'boolean' | 'json'
  options?: string[]
  required: boolean
  description?: string
  defaultValue?: unknown
  /** 来自当前页面的上下文 */
  fromContext?: boolean
}

export type FieldValue = string | boolean

interface PropSchema {
  type?: string | string[]
  title?: string
  description?: string
  enum?: unknown[]
  default?: unknown
}

export function fieldsOf(cmd: CommandInfo): FieldSpec[] {
  const schema = cmd.input as { properties?: Record<string, PropSchema>; required?: string[] }
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([key, p]) => {
    const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type
    const type: FieldSpec['type'] = p.enum ? 'enum' : t === 'string' ? 'string' : t === 'number' || t === 'integer' ? 'number' : t === 'boolean' ? 'boolean' : 'json'
    return { key, title: p.title ?? key, type, options: p.enum?.map(String), required: required.has(key), description: p.description, defaultValue: p.default }
  })
}

const CONTEXT_KEYS: Record<string, keyof PaletteContext> = { requirementId: 'requirementId', runId: 'runId', nodeId: 'nodeId' }

/** 初值：调用方给的 > 页面上下文 > schema 默认值。 */
export function initialValues(fields: FieldSpec[], ctx: PaletteContext, given: Record<string, unknown> = {}): { values: Record<string, FieldValue>; fromContext: Set<string> } {
  const values: Record<string, FieldValue> = {}
  const fromContext = new Set<string>()
  for (const f of fields) {
    const g = given[f.key]
    const c = CONTEXT_KEYS[f.key] ? ctx[CONTEXT_KEYS[f.key]!] : undefined
    if (g !== undefined) values[f.key] = f.type === 'boolean' ? !!g : f.type === 'json' ? JSON.stringify(g) : String(g)
    else if (c) {
      values[f.key] = c
      fromContext.add(f.key)
    } else if (f.defaultValue !== undefined) values[f.key] = f.type === 'boolean' ? !!f.defaultValue : f.type === 'json' ? JSON.stringify(f.defaultValue) : String(f.defaultValue)
    else values[f.key] = f.type === 'boolean' ? false : ''
  }
  return { values, fromContext }
}

/** 表单值 → 命令输入；空字符串视为未填。返回缺少的必填项与无法解析的 JSON 字段。 */
export function toInput(fields: FieldSpec[], values: Record<string, FieldValue>): { input: Record<string, unknown>; missing: string[]; invalid: string[] } {
  const input: Record<string, unknown> = {}
  const missing: string[] = []
  const invalid: string[] = []
  for (const f of fields) {
    const v = values[f.key]
    if (f.type === 'boolean') {
      input[f.key] = !!v
      continue
    }
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s) {
      if (f.required) missing.push(f.title)
      continue
    }
    if (f.type === 'number') {
      const n = Number(s)
      if (Number.isFinite(n)) input[f.key] = n
      else invalid.push(f.title)
    } else if (f.type === 'json') {
      try {
        input[f.key] = JSON.parse(s)
      } catch {
        invalid.push(f.title)
      }
    } else input[f.key] = s
  }
  return { input, missing, invalid }
}
