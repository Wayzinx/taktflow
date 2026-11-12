import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, brotliCompressSync, constants, gzip, gzipSync } from 'node:zlib'
import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { decode, HttpError } from './http.js'

export const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' }

function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') }

/** 文本类响应才值得压缩；太小的压了反而更大。 */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg\+xml)/
const MIN_COMPRESS = 1024

/** 按 Accept-Encoding 选编码：br 优先，其次 gzip；q=0 表示不接受。 */
export function pickEncoding(accept: IncomingHttpHeaders['accept-encoding']): 'br' | 'gzip' | undefined {
  const offered = new Map<string, number>()
  for (const part of (Array.isArray(accept) ? accept.join(',') : accept ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map(p => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean)
    if (name) offered.set(name, q === undefined ? 1 : Number(q))
  }
  const quality = (name: string) => offered.get(name) ?? offered.get('*') ?? 0
  const br = quality('br')
  const gz = quality('gzip')
  return br > 0 && br >= gz ? 'br' : gz > 0 ? 'gzip' : undefined
}

const compressible = (contentType: string, body: Buffer) => body.length >= MIN_COMPRESS && COMPRESSIBLE.test(contentType)
const brotliOptions = (quality: number, size: number) => ({ params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: size } })

/**
 * 写一个完整的响应体（API 的 JSON 用）：超过 1KB 的文本且客户端接受时压缩（br 用低档位，几百 KB 也只要几毫秒），带 vary: accept-encoding。
 * 同步完成，调用方仍可以把它当作"写完即结束"。
 */
export function sendBody(response: ServerResponse, status: number, headers: OutgoingHttpHeaders, body: string | Buffer): void {
  const raw = typeof body === 'string' ? Buffer.from(body) : body
  const type = String(response.getHeader('content-type') ?? headers['content-type'] ?? '')
  const head = response.req?.method === 'HEAD'
  const empty = status === 204 || status === 304
  const alreadyEncoded = headers['content-encoding'] ?? response.getHeader('content-encoding')
  const streaming = type.startsWith('text/event-stream')
  const encoding = !head && !empty && !alreadyEncoded && !streaming && compressible(type, raw) ? pickEncoding(response.req?.headers['accept-encoding']) : undefined
  const out = encoding === 'br' ? brotliCompressSync(raw, brotliOptions(4, raw.length)) : encoding === 'gzip' ? gzipSync(raw, { level: 6 }) : raw
  response.writeHead(status, { ...headers, 'content-type': type, ...(COMPRESSIBLE.test(type) ? { vary: appendVary(headers.vary ?? response.getHeader('vary')) } : {}), ...(encoding ? { 'content-encoding': encoding } : {}), ...(!empty ? { 'content-length': out.length } : {}) })
  response.end(head || empty ? undefined : out)
}

function appendVary(current: ReturnType<ServerResponse['getHeader']>): string {
  const list = String(current ?? '').split(',').map(v => v.trim()).filter(Boolean)
  return list.some(v => v.toLowerCase() === 'accept-encoding') ? list.join(', ') : [...list, 'Accept-Encoding'].join(', ')
}

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)
/** 静态文件压缩结果按 路径 + 修改时间 + 编码 缓存（构建产物不变，压一次就够），总量超过上限时整体清空。 */
const compressed = new Map<string, Buffer>()
let compressedBytes = 0
const COMPRESSED_LIMIT = 64 * 1024 * 1024

async function encodeStatic(file: string, version: string, content: Buffer, encoding: 'br' | 'gzip'): Promise<Buffer> {
  const key = `${encoding}:${file}:${version}`
  const hit = compressed.get(key)
  if (hit) return hit
  const out = encoding === 'br' ? await brotliAsync(content, brotliOptions(9, content.length)) : await gzipAsync(content, { level: 9 })
  if (compressedBytes + out.length > COMPRESSED_LIMIT) { compressed.clear(); compressedBytes = 0 }
  compressed.set(key, out)
  compressedBytes += out.length
  return out
}

/** vite 产物 /assets/<名字>-<内容哈希>.<扩展名>：内容变了文件名就变，可以永久缓存。 */
const HASHED_ASSET = /^\/assets\/[^/]+-[\w-]{8,}\.[a-z0-9]+$/i

export async function staticFile(webDir: string | undefined, pathname: string, response: ServerResponse, head: boolean): Promise<void> {
  if (!webDir) throw new HttpError(404, '路径不存在')
  const decoded = decode(pathname)
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) throw new HttpError(400, '静态文件路径不合法')
  let root: string
  try { root = await realpath(webDir) } catch (error) { if (missing(error)) throw new HttpError(404, '静态目录不存在'); throw error }
  const resolve = async (file: string): Promise<{ file: string; size: number; mtimeMs: number } | undefined> => {
    try {
      const actual = await realpath(file)
      const relative = path.relative(root, actual)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new HttpError(404, '静态文件不存在')
      const info = await stat(actual)
      return info.isFile() ? { file: actual, size: info.size, mtimeMs: info.mtimeMs } : undefined
    } catch (error) { if (missing(error)) return undefined; throw error }
  }
  const direct = await resolve(path.join(root, decoded))
  const found = direct ?? await resolve(path.join(root, 'index.html'))
  if (!found) throw new HttpError(404, '静态文件不存在')
  const { file } = found
  const type = contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  // 带哈希的资源一年不过期；其余（index.html、SPA 回退、图标）每次用 ETag 协商，发版后立刻生效
  const immutable = !!direct && HASHED_ASSET.test(decoded)
  const version = `${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}`
  const etag = `W/"${version}"`
  const headers: OutgoingHttpHeaders = { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', etag }
  const content = await readFile(file)
  const encoding = !head && !response.getHeader('content-encoding') && compressible(type, content) ? pickEncoding(response.req?.headers['accept-encoding']) : undefined
  if (COMPRESSIBLE.test(type)) headers.vary = appendVary(response.getHeader?.('vary'))
  if (!immutable && response.req?.headers['if-none-match']?.split(',').some(t => t.trim() === etag)) { response.writeHead(304, headers); response.end(); return }
  const body = encoding ? await encodeStatic(file, version, content, encoding) : content
  response.writeHead(200, { ...headers, ...(encoding ? { 'content-encoding': encoding } : {}), 'content-length': body.length })
  response.end(head ? undefined : body)
}
