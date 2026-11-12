import { schemaErrors } from '../engine/schema.js'

type Schema = Record<string, unknown>
const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', '$ref', '$defs', '$schema', 'title', 'description', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])

/** 严格输出只接受可证明等价的子集，其余交给提示词和完整校验。 */
export function toStrictSchema(schema: Schema): Schema {
  const visit = (input: unknown, path: string): Schema => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${path}：严格模式不支持布尔或空 schema`)
    const node = input as Schema
    for (const key of Object.keys(node)) if (!supported.has(key)) throw new Error(`${path}：严格模式不支持关键字 ${key}`)
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) throw new Error(`${path}：严格模式不支持自由键 map（additionalProperties）`)
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) throw new Error(`${path}：严格模式只支持本地 $ref`)
    const out = { ...node }
    if (node.$defs) out.$defs = Object.fromEntries(Object.entries(node.$defs as Schema).map(([key, child]) => [key, visit(child, `${path}.$defs.${key}`)]))
    if (Array.isArray(node.anyOf)) out.anyOf = node.anyOf.map((child, i) => visit(child, `${path}.anyOf[${i}]`))
    if (node.items !== undefined) out.items = visit(node.items, `${path}.items`)
    if (node.type === 'object' || Array.isArray(node.type) && node.type.includes('object') || node.properties) {
      const props = node.properties as Schema | undefined ?? {}
      const required = node.required as string[] | undefined ?? []
      // 没列字段的对象在 JSON Schema 里是开放的；严格模式会把它收成只能输出 {}，内容被悄悄丢掉。
      if (!Object.keys(props).length && node.additionalProperties !== false) throw new Error(`${path}：严格模式不支持没列字段的开放对象`)
      if (required.some(key => !Object.hasOwn(props, key))) throw new Error(`${path}：必填字段没有 properties 定义`)
      out.properties = Object.fromEntries(Object.entries(props).map(([key, child]) => {
        const converted = visit(child, `${path}.${key}`)
        return [key, required.includes(key) ? converted : { anyOf: [converted, { type: 'null' }] }]
      }))
      out.required = Object.keys(props)
      out.additionalProperties = false
    } else if (!node.type && !node.anyOf && !node.$ref && !node.enum && node.const === undefined) {
      throw new Error(`${path}：严格模式不支持无类型约束的 schema`)
    }
    return out
  }
  const converted = visit(schema, '$')
  if (converted.type !== 'object' || converted.anyOf) throw new Error('$：严格模式需要对象根结构')
  return converted
}

export function dropNullOptionals(value: unknown, schema: Schema): unknown {
  const resolve = (ref: string): unknown => ref === '#' ? schema : ref.startsWith('#/')
    ? ref.slice(2).split('/').reduce<unknown>((node, key) => node && typeof node === 'object' ? (node as Schema)[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined, schema) : undefined
  const visit = (data: unknown, node: Schema, refs = new Set<string>()): unknown => {
    if (typeof node.$ref === 'string' && !refs.has(node.$ref)) {
      const target = resolve(node.$ref)
      if (target && typeof target === 'object') data = visit(data, target as Schema, new Set([...refs, node.$ref]))
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (!Array.isArray(node[key])) continue
      const branches = node[key] as Schema[]
      if (key === 'allOf') for (const branch of branches) data = visit(data, branch, refs)
      else {
        // 先还原候选，再按原结构择支，保留合法的必填 null。
        for (const branch of branches) {
          const candidate = visit(data, branch, refs)
          if (!schemaErrors(candidate, { $defs: schema.$defs, ...branch }).length) { data = candidate; break }
        }
      }
    }
    if (Array.isArray(data) && node.items && typeof node.items === 'object') return data.map(item => visit(item, node.items as Schema))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data
    const props = node.properties as Record<string, Schema> | undefined ?? {}
    const required = node.required as string[] | undefined ?? []
    return Object.fromEntries(Object.entries(data).filter(([key, item]) => !(Object.hasOwn(props, key) && !required.includes(key) && item === null))
      .map(([key, item]) => [key, Object.hasOwn(props, key) ? visit(item, props[key]!) : item]))
  }
  return visit(value, schema)
}
