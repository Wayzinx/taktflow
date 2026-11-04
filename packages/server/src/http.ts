import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Actor } from '@taktflow/core'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

export function fail(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return }
  json(response, { error: error instanceof HttpError ? error.message : '服务器内部错误' }, error instanceof HttpError ? error.status : 500)
}

export function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { throw new HttpError(400, 'URL 编码不合法') }
}

export function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new HttpError(400, 'ID 不合法')
  return value
}

export function relativePath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new HttpError(400, '相对路径不合法')
  }
  return value
}

export function artifactPath(value: unknown): string {
  const result = relativePath(value)
  if (['requirement.json', 'manifest.json', 'comments.jsonl'].includes(result.split('/')[0]!.toLowerCase())) throw new HttpError(400, '产物路径与元数据冲突')
  return result
}

export function integer(value: string | null, name: string, min = 0): number | undefined {
  if (value === null) return undefined
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new HttpError(400, `${name} 不合法`)
  return Number(value)
}

export function text(value: unknown, name: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new HttpError(400, `${name} 必须是${empty ? '' : '非空'}字符串`)
  return value
}

export async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 8 * 1024 * 1024) throw new HttpError(400, '请求体过大')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, '请求体必须是合法 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求体必须是对象')
  return value as Record<string, unknown>
}

export function actor(request: IncomingMessage): Actor {
  const value = request.headers['x-takt-user']
  return { type: 'human', id: (Array.isArray(value) ? value[0] : value)?.trim() || 'web' }
}
