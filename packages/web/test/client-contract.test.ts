/**
 * client ↔ server 契约（评审发现 #1 #2 #20）：
 * - 每个写请求都要过服务端真实的 validateWriteRequest（无 body 的 POST 曾经 415）；
 * - 每个请求的方法 + 路径都在 packages/core/src/api.ts 顶部的接口表里；
 * - 管家接口（含两条 SSE）带全局身份 x-takt-user，空间内选的"我是"在全局 /steward 页也生效。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { validateWriteRequest } from '../../server/src/http.js'

const here = dirname(fileURLToPath(import.meta.url))
const table = readFileSync(join(here, '../../core/src/api.ts'), 'utf8')
  .split('\n')
  .flatMap((l) => {
    const m = /^ \* \|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*(\/api\/\S+)/.exec(l)
    return m ? [{ method: m[1]!, re: new RegExp(`^${m[2]!.split('?')[0]!.replace(/:[A-Za-z]+/g, '[^/]+')}$`) }] : []
  })

type Call = { method: string; path: string; headers: Record<string, string>; body?: string }
const calls: Call[] = []
const store = new Map<string, string>()

beforeAll(() => {
  vi.stubGlobal('location', { pathname: '/s/shop/knowledge' })
  vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', path: url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined })
    if (String((init.headers as Record<string, string> | undefined)?.accept).includes('event-stream')) return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterAll(() => vi.unstubAllGlobals())

const asRequest = (c: Call) => ({ method: c.method, headers: { host: 'localhost:4883', ...Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toLowerCase(), v])) } }) as unknown as IncomingMessage
const strip = (path: string) => path.split('?')[0]!.replace(/^\/api\/s\/[^/]+/, '/api')

describe('HTTP client contract', () => {
  it('every M4 call is a documented route and every write passes validateWriteRequest', async () => {
    const { createHttpSource } = await import('../src/api/client')
    const ds = createHttpSource()
    calls.length = 0
    await Promise.all([
      ds.testKnowledgeBase('kb'), ds.cancelKnowledgeBuild('kb', 'b1'), ds.harvestKnowledgeCases('kb', 'set'),
      ds.startKnowledgeBuild('kb', 'r'), ds.publishKnowledge('kb', { reason: 'r' }), ds.queryKnowledge('kb', { text: 'q' }),
      ds.createKnowledgeBase({ id: 'kb', name: 'kb', kind: 'rag', config: {}, reason: 'r' } as never), ds.updateKnowledgeBase('kb', { reason: 'r' } as never), ds.deleteKnowledgeBase('kb', 'r'),
      ds.uploadKnowledge('kb', { files: [] }), ds.saveKnowledgeEvalCases('kb', 'set', []), ds.synthesizeKnowledgeCases('kb', 'set', 3),
      ds.startKnowledgeEvalRun('kb', { setId: 'set', variants: [] } as never), ds.saveKnowledgeBindings([], 'r'), ds.putKnowledgeSecret('n', 'v'), ds.migrateKnowledge(true),
      ds.createSpace({ id: 'x', name: 'x', reason: 'r' } as never), ds.archiveSpace('x', 'r'), ds.restoreSpace('x@20260101-000000', 'r'), ds.deleteSpace('x@20260101-000000', { confirm: 'x@20260101-000000', reason: 'r' }),
      ds.createRequirement({ title: 't' }), ds.archiveRequirement('REQ-1', 'r'), ds.convertWorkflow('wf', { dryRun: true }),
      ds.createStewardThread({ text: 'hi' }), ds.postStewardMessage('t1', { text: 'hi' }), ds.approveProposal('p', { hash: 'h' }), ds.rejectProposal('p'), ds.undoProposal('p', 'r'),
      ds.setRiskState('k', { state: 'ignored' }), ds.saveStewardProfile('x'), ds.stewardFeedback('m', { rating: 'up' } as never),
      ds.digest(undefined, { peek: true }), ds.knowledgeKinds(), ds.stewardThreads(),
    ])
    expect(calls.length).toBeGreaterThan(30)
    for (const c of calls) {
      expect(table.some((r) => r.method === c.method && r.re.test(strip(c.path))), `${c.method} ${c.path} 不在 api.ts 接口表里`).toBe(true)
      expect(() => validateWriteRequest(asRequest(c)), `${c.method} ${c.path}`).not.toThrow()
      if (c.method !== 'GET') expect(c.body, `${c.method} ${c.path} 写请求要带 JSON body`).toBeTruthy()
    }
    // 全局接口不加空间前缀，空间内接口加
    expect(calls.find((c) => c.path.includes('/steward/threads'))!.path.startsWith('/api/steward/')).toBe(true)
    expect(calls.find((c) => c.path.includes('/knowledge/kinds'))!.path).toBe('/api/s/shop/knowledge/kinds')
    expect(calls.find((c) => c.path.includes('/steward/digest'))!.path).toBe('/api/steward/digest?peek=1')
    // 服务端 PUT /knowledge/secrets/:name 要求 reason（协议只写了 { value }）
    expect(JSON.parse(calls.find((c) => c.path.includes('/knowledge/secrets/'))!.body!)).toMatchObject({ value: 'v', reason: expect.any(String) })
  })

  it('steward calls and streams carry the global identity, even on the global /steward page', async () => {
    const { setActingUser } = await import('../src/lib/acting-user')
    const { createHttpSource } = await import('../src/api/client')
    setActingUser('bob') // 在空间 shop 里选了"我是 bob"
    vi.stubGlobal('location', { pathname: '/steward' })
    const ds = createHttpSource()
    calls.length = 0
    await ds.stewardThreads()
    const off = ds.subscribeSteward('t1', () => undefined)
    const offFeed = ds.subscribeStewardFeed(() => undefined)
    await new Promise((r) => setTimeout(r, 10))
    off()
    offFeed()
    const steward = calls.filter((c) => c.path.startsWith('/api/steward/'))
    expect(steward.map((c) => c.path)).toEqual(expect.arrayContaining(['/api/steward/threads', '/api/steward/threads/t1/stream', '/api/steward/stream']))
    for (const c of steward) expect(c.headers['x-takt-user'], c.path).toBe('bob')
  })
})
