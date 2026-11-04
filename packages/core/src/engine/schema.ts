import { extractJsonBlock } from '../util/json-block.js'

export function validateSchema(value: unknown, schema: Record<string, unknown>, path = '$'): void {
  const type = schema.type
  const valid = type === undefined || (type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
    : type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
    : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : typeof value === type)
  if (!valid) throw new Error(`${path}: expected ${String(type)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`${path}: value not in enum`)
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key}: required`)
    }
    for (const [key, child] of Object.entries((schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {})) {
      if (Object.hasOwn(record, key)) validateSchema(record[key], child, `${path}.${key}`)
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateSchema(item, schema.items as Record<string, unknown>, `${path}[${index}]`))
  }
}

export function parseResult(text: string, schema: Record<string, unknown>): unknown {
  const value = extractJsonBlock(text)
  if (value === undefined) throw new Error('结构化结果缺少有效且闭合的最后 json 代码块')
  validateSchema(value, schema)
  return value
}
