import type { EventPayloads } from '../types.js'

// 协议尚未提供独立事件的审计数据只在这里编码/解码；普通日志解析失败不影响读取。
export function structuredLog(value: object): EventPayloads['log'] {
  return { level: 'info', message: JSON.stringify(value) }
}
export function parseStructuredLog(data: EventPayloads['log']): unknown {
  try { return JSON.parse(data.message) } catch { return undefined }
}
