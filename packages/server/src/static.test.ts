/** TF-064：静态资源按 Accept-Encoding 压缩、带哈希的资源长缓存、index.html 每次协商；API JSON 同样压缩。 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pickEncoding, sendBody, staticFile } from './static.js'
import { json as sendJson } from './http.js'

let dir: string
let server: Server
let base: string
const js = `console.log(${JSON.stringify('x'.repeat(4000))})\n`
const json = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `需求 ${i}` })) })

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'takt-static-'))
  await mkdir(path.join(dir, 'assets'))
  await writeFile(path.join(dir, 'index.html'), `<!doctype html><title>t</title>${'<!-- pad -->'.repeat(200)}`)
  await writeFile(path.join(dir, 'assets', 'index-BHTDS7wW.js'), js)
  await writeFile(path.join(dir, 'favicon.svg'), '<svg/>')
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/api/data') return sendJson(res, JSON.parse(json))
    if (url.pathname === '/api/special') {
      const type = url.searchParams.get('type') ?? 'application/json'
      res.setHeader('vary', 'Origin')
      if (url.searchParams.has('encoded')) res.setHeader('content-encoding', 'identity')
      return sendBody(res, Number(url.searchParams.get('status') ?? 200), { 'content-type': type }, json)
    }
    void staticFile(dir, url.pathname, res, req.method === 'HEAD').catch(() => res.writeHead(500).end())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(dir, { recursive: true, force: true })
})

function fetchRaw(pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request(base + pathname, { headers, method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject).end()
  })
}

describe('pickEncoding', () => {
  it('br 优先，其次 gzip；q=0 不接受', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br')
    expect(pickEncoding('gzip')).toBe('gzip')
    expect(pickEncoding('br;q=0, gzip;q=0.8')).toBe('gzip')
    expect(pickEncoding('identity')).toBeUndefined()
    expect(pickEncoding(undefined)).toBeUndefined()
    expect(pickEncoding('*')).toBe('br')
    expect(pickEncoding('br;q=0.1, gzip;q=0.9')).toBe('gzip')
  })
})

describe('静态资源', () => {
  it('带哈希的 JS：br 压缩、一年不过期、内容不变', async () => {
    const r = await fetchRaw('/assets/index-BHTDS7wW.js', { 'accept-encoding': 'gzip, deflate, br' })
    expect(r.status).toBe(200)
    expect(r.headers['content-encoding']).toBe('br')
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(r.headers.vary).toMatch(/accept-encoding/i)
    expect(Number(r.headers['content-length'])).toBe(r.body.length)
    expect(r.body.length).toBeLessThan(js.length / 4)
    expect(brotliDecompressSync(r.body).toString()).toBe(js)
  })

  it('只接受 gzip 时用 gzip；不接受压缩时原样发', async () => {
    const g = await fetchRaw('/assets/index-BHTDS7wW.js', { 'accept-encoding': 'gzip' })
    expect(g.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(g.body).toString()).toBe(js)
    const plain = await fetchRaw('/assets/index-BHTDS7wW.js')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.toString()).toBe(js)
  })

  it('index.html 和 SPA 回退不缓存，用 ETag 协商；没变时 304', async () => {
    const page = await fetchRaw('/s/demo/settings', { 'accept-encoding': 'br' })
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.headers['cache-control']).toBe('no-cache')
    const etag = page.headers.etag!
    expect(etag).toBeTruthy()
    const again = await fetchRaw('/', { 'if-none-match': etag })
    expect(again.status).toBe(304)
    expect(again.body.length).toBe(0)
  })

  it('不存在的 /assets 文件回退到 index.html 时不能被当成长缓存资源', async () => {
    const r = await fetchRaw('/assets/gone-ABCDEFGH.js')
    expect(r.headers['content-type']).toContain('text/html')
    expect(r.headers['cache-control']).toBe('no-cache')
  })

  it('太小的文件不压缩', async () => {
    const r = await fetchRaw('/favicon.svg', { 'accept-encoding': 'br' })
    expect(r.headers['content-encoding']).toBeUndefined()
    expect(r.body.toString()).toBe('<svg/>')
  })
})

describe('API JSON', () => {
  it('HEAD、204、304、已有编码、SSE 不压缩；保留 Vary', async () => {
    for (const status of [204, 304]) {
      const r = await fetchRaw(`/api/special?status=${status}`, { 'accept-encoding': 'br' })
      expect(r.headers['content-encoding']).toBeUndefined()
      expect(r.body.length).toBe(0)
    }
    const head = await fetchRaw('/api/data', { 'accept-encoding': 'br' }, 'HEAD')
    expect(head.headers['content-encoding']).toBeUndefined()
    expect(head.body.length).toBe(0)
    const encoded = await fetchRaw('/api/special?encoded=1', { 'accept-encoding': 'br' })
    expect(encoded.headers['content-encoding']).toBe('identity')
    expect(encoded.body.toString()).toBe(json)
    expect(encoded.headers.vary).toBe('Origin, Accept-Encoding')
    const sse = await fetchRaw('/api/special?type=text/event-stream', { 'accept-encoding': 'br' })
    expect(sse.headers['content-encoding']).toBeUndefined()
  })
  it('按 Accept-Encoding 压缩，解压后与原文一致', async () => {
    const r = await fetchRaw('/api/data', { 'accept-encoding': 'gzip, br' })
    expect(r.headers['content-encoding']).toBe('br')
    expect(r.headers.vary).toMatch(/accept-encoding/i)
    expect(JSON.parse(brotliDecompressSync(r.body).toString())).toEqual(JSON.parse(json))
    const plain = await fetchRaw('/api/data')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.toString()).toBe(json)
  })
})
