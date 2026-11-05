import type { EditableValue } from '@taktflow/core'

export function serializeLiteral(value: unknown): string {
  if (typeof value === 'string') {
    if (value.includes('\n')) return '`' + value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r').replace(/\0/g, '\\x00') + '`'
    return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\x00-\x1f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) + "'"
  }
  if (value === null) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? '-0' : String(value)
  if (Array.isArray(value)) return `[${Array.from(value, serializeLiteral).join(', ')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('字面量只能使用普通对象')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.length ? `{ ${entries.map(([key, item]) => `${serializeKey(key)}: ${serializeLiteral(item)}`).join(', ')} }` : '{}'
  }
  throw new Error(`不支持的字面量：${String(value)}`)
}

export function serializeKey(key: string): string {
  if (key === '__proto__') return "['__proto__']"
  return /^[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*$/u.test(key) ? key : serializeLiteral(key)
}

export function serializeValue(value: EditableValue): string {
  return value.kind === 'code' ? value.code : serializeLiteral(value.value)
}
