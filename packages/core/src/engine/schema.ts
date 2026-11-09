import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import { jsonBlockValues } from '../util/json-block.js'

const ajv = new Ajv2020({ allErrors: true, strict: false, addUsedSchema: false })
const validators = new WeakMap<object, ValidateFunction>()

function errorPath(pointer: string, value: unknown): string {
  let path = '$'
  for (const part of pointer.split('/').slice(1)) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    path += Array.isArray(value) ? `[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  }
  return path
}

function reason(error: ErrorObject): string {
  const p = error.params
  switch (error.keyword) {
    case 'type': return `应为 ${Array.isArray(p.type) ? p.type.join(' / ') : p.type}`
    case 'required': return `缺少必填字段 ${p.missingProperty}`
    case 'additionalProperties': return `不允许的字段 ${p.additionalProperty}`
    case 'enum': return `取值须为 ${p.allowedValues.map((v: unknown) => typeof v === 'string' ? v : JSON.stringify(v)).join(' / ')} 之一`
    case 'const': return `取值须为 ${JSON.stringify(p.allowedValue)}`
    case 'minItems': return `至少需要 ${p.limit} 项`
    case 'maxItems': return `最多允许 ${p.limit} 项`
    case 'minLength': return `长度至少为 ${p.limit}`
    case 'maxLength': return `长度最多为 ${p.limit}`
    case 'pattern': return `须匹配模式 ${p.pattern}`
    case 'minimum': return `须大于或等于 ${p.limit}`
    case 'maximum': return `须小于或等于 ${p.limit}`
    case 'exclusiveMinimum': return `须大于 ${p.limit}`
    case 'exclusiveMaximum': return `须小于 ${p.limit}`
    case 'multipleOf': return `须为 ${p.multipleOf} 的倍数`
    case 'anyOf': return '须满足至少一种候选结构'
    case 'oneOf': return '须且只能满足一种候选结构'
    case 'not': return '不能满足被排除的结构'
    case 'uniqueItems': return '数组项不得重复'
    case 'minProperties': return `至少需要 ${p.limit} 个字段`
    case 'maxProperties': return `最多允许 ${p.limit} 个字段`
    case 'false schema': return '不允许此值'
    default: return `不符合 ${error.keyword} 约束`
  }
}

export function schemaErrors(value: unknown, schema: Record<string, unknown>): string[] {
  let validate = validators.get(schema)
  if (!validate) {
    try { validate = ajv.compile(schema) }
    catch (error) { throw new Error(`JSON Schema 无效：${error instanceof Error ? error.message : String(error)}`) }
    validators.set(schema, validate)
  }
  return validate(value) ? [] : (validate.errors ?? []).map(error => `${errorPath(error.instancePath, value)}：${reason(error)}`)
}

export function validateSchema(value: unknown, schema: Record<string, unknown>, path = '$'): void {
  const errors = schemaErrors(value, schema).map(error => path + error.slice(1))
  if (errors.length) throw new Error(errors.join('；'))
}

export function extractStructured(text: string, schema?: Record<string, unknown>): { value?: unknown; problem?: string } {
  const block = jsonBlockValues(text)
  if (block.values) {
    const valid = schema && block.values.length > 1 ? block.values.filter(value => schemaErrors(value, schema).length === 0) : block.values
    const value = (valid.length ? valid : block.values).at(-1)
    return { value }
  }
  try { return { value: JSON.parse(text) as unknown } }
  catch { return { problem: block.problem } }
}

export function parseResult(text: string, schema: Record<string, unknown>): unknown {
  const { value, problem } = extractStructured(text, schema)
  if (problem) throw new Error(problem)
  validateSchema(value, schema)
  return value
}
