import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { decode, HttpError } from './http.js'

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' }

function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') }

export async function staticFile(webDir: string | undefined, pathname: string, response: ServerResponse, head: boolean): Promise<void> {
  if (!webDir) throw new HttpError(404, '路径不存在')
  const decoded = decode(pathname)
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) throw new HttpError(400, '静态文件路径不合法')
  let root: string
  try { root = await realpath(webDir) } catch (error) { if (missing(error)) throw new HttpError(404, '静态目录不存在'); throw error }
  const resolve = async (file: string): Promise<string | undefined> => {
    try {
      const actual = await realpath(file)
      const relative = path.relative(root, actual)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new HttpError(404, '静态文件不存在')
      return (await stat(actual)).isFile() ? actual : undefined
    } catch (error) { if (missing(error)) return undefined; throw error }
  }
  const file = await resolve(path.join(root, decoded)) ?? await resolve(path.join(root, 'index.html'))
  if (!file) throw new HttpError(404, '静态文件不存在')
  const content = await readFile(file)
  response.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': content.length, 'x-content-type-options': 'nosniff' })
  response.end(head ? undefined : content)
}
