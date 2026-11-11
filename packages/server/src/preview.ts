import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { contentTypes } from './static.js'

/**
 * 成品预览（docs/design/17 §代码仓库）：运行做出来的网页在集成工作树里，要经 HTTP 打开。
 * 另开一个端口而不是挂在平台下面：和平台不同源，生成的页面读不到平台接口、写请求被来源校验拦下，自己的 localStorage 照常可用。
 * 只服务登记过的目录（路径里带随机令牌），不列目录，不给 . 开头的文件和目录（.git、.takt）。
 */
export interface PreviewServer {
  /** 登记目录，返回 file 在预览端口上的地址；host 用访问平台时的主机名，端口是预览端口。 */
  url(dir: string, file: string, host: string): Promise<string>
  close(): Promise<void>
}

export function createPreviewServer(bind = '127.0.0.1'): PreviewServer {
  const roots = new Map<string, string>()
  const tokens = new Map<string, string>()
  let server: Server | undefined
  let starting: Promise<number> | undefined
  const notFound = (res: import('node:http').ServerResponse) => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('预览文件不存在') }
  const listen = () => starting ??= new Promise<number>((resolve, reject) => {
    const instance = createServer((req, res) => void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      const [, token, ...rest] = decodeURIComponent(new URL(req.url ?? '/', 'http://preview').pathname).split('/')
      const root = token ? roots.get(token) : undefined
      if (!root || rest.some((part) => part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return notFound(res)
      let file = path.join(root, ...rest)
      try {
        let info = await stat(file)
        if (info.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file) }
        const actual = await realpath(file)
        const relative = path.relative(root, actual)
        if (!info.isFile() || relative.startsWith('..') || path.isAbsolute(relative)) return notFound(res)
        const content = await readFile(actual)
        res.writeHead(200, { 'content-type': contentTypes[path.extname(actual).toLowerCase()] ?? 'application/octet-stream', 'content-length': content.length,
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(req.method === 'HEAD' ? undefined : content)
      } catch {
        notFound(res)
      }
    })())
    instance.once('error', reject)
    instance.listen(0, bind, () => { instance.off('error', reject); instance.unref(); server = instance; resolve((instance.address() as { port: number }).port) })
  }).catch((error) => { starting = undefined; throw error })
  return {
    async url(dir, file, host) {
      const root = await realpath(dir)
      let token = tokens.get(root)
      if (!token) { token = randomBytes(12).toString('hex'); tokens.set(root, token); roots.set(token, root) }
      const port = await listen()
      const hostname = host.replace(/:\d+$/, '') || bind
      return `http://${hostname}:${port}/${token}/${file.split('/').map(encodeURIComponent).join('/')}`
    },
    async close() {
      const instance = server
      server = undefined; starting = undefined
      if (instance) await new Promise<void>((resolve) => { instance.close(() => resolve()); instance.closeAllConnections() })
    },
  }
}
