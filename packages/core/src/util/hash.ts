import { createHash } from 'node:crypto'

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJson(value: unknown): string {
  // 先按落盘语义处理 undefined、稀疏数组和 toJSON，避免读回后事件哈希变化。
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('无法规范化没有 JSON 表示的值')
  return serialize(JSON.parse(json))
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)!
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`
}
