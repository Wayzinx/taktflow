/**
 * client ↔ server 契约（评审发现 #1 #2 #20）：
 * - 每个写请求都要过服务端真实的 validateWriteRequest（无 body 的 POST 曾经 415）；
 * - 每个请求的方法 + 路径都在 packages/core/src/api.ts 顶部的接口表里；
 * - 管家接口（含两条 SSE）使用所属空间的成员身份，个人管家使用全局身份。
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
    return m ? [{ method: m[1]!, path: m[2]!.split('?')[0]!, re: new RegExp(`^${m[2]!.split('?')[0]!.replace(/:[A-Za-z]+/g, '[^/]+')}$`) }] : []
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
    expect(calls.find((c) => c.path.includes('/steward/threads'))!.path).toBe('/api/s/shop/space/steward/threads')
    expect(calls.find((c) => c.path.includes('/knowledge/kinds'))!.path).toBe('/api/s/shop/knowledge/kinds')
    expect(calls.find((c) => c.path.includes('/steward/digest'))!.path).toBe('/api/s/shop/space/steward/digest?peek=1')
    // 服务端 PUT /knowledge/secrets/:name 要求 reason（协议只写了 { value }）
    expect(JSON.parse(calls.find((c) => c.path.includes('/knowledge/secrets/'))!.body!)).toMatchObject({ value: 'v', reason: expect.any(String) })
  })

  it.each([
    { page: '/s/shop/solo', prefix: '/api/s/shop/space/steward', user: 'alice' },
    { page: '/s/studio/knowledge', prefix: '/api/s/studio/space/steward', user: 'bob' },
    { page: '/steward', prefix: '/api/space/steward', user: 'local' },
    { page: '/personal', prefix: '/api/steward', user: 'bob' },
    { page: '/solo', prefix: '/api/steward', user: 'bob' },
  ])('all steward HTTP calls and both streams on $page use $prefix as $user', async ({ page, prefix, user }) => {
    const { setActingUser } = await import('../src/lib/acting-user')
    const { createHttpSource } = await import('../src/api/client')
    const at = (pathname: string) => vi.stubGlobal('location', { pathname })
    at('/'); setActingUser('local')
    at('/s/shop/knowledge'); setActingUser('alice')
    at('/s/studio/knowledge'); setActingUser('bob') // 最近的全局身份，shop 的身份仍是 alice
    at(page)
    const ds = createHttpSource()
    calls.length = 0
    const off = ds.subscribeSteward('t1', () => undefined)
    const offFeed = ds.subscribeStewardFeed(() => undefined)
    try {
      await Promise.all([
        ds.stewardThreads(), ds.createStewardThread({ text: 'hi' }), ds.stewardThread('t1'), ds.patchStewardThread('t1', { title: 'hello' }),
        ds.deleteStewardThread('t1'), ds.stopStewardThread('t1'), ds.stewardRuntimeChoices(), ds.postStewardMessage('t1', { text: 'ok' }),
        ds.stewardFeedback('m', { rating: 'up' }), ds.resendDelegation('m', 'retry'), ds.proposals(),
        ds.approveProposal('p', { hash: 'h' }), ds.rejectProposal('p'), ds.undoProposal('p', 'undo'),
        ds.risks(), ds.setRiskState('k', { state: 'ignored' }), ds.digest(undefined, { peek: true }),
        ds.stewardFeed(), ds.stewardUnread(), ds.stewardPrefs(), ds.saveStewardPrefs({ trust: 'confirm', digestTimes: [] }),
        ds.stewardProfile(), ds.saveStewardProfile('memo'), ds.stewardSuggestions({ page: 'overview' }),
        ds.stewardFind('q'), ds.stewardPicks(), ds.productMetrics(), ds.reportProductEvent({ type: 'dialog.open', feature: 'requirement.create' }),
      ])
      await vi.waitFor(() => expect(calls.filter(c => c.headers.accept === 'text/event-stream').length).toBe(2))
      const documentedRoot = strip(prefix) + '/'
      const documented = table.filter(r => r.path.startsWith(documentedRoot) && r.path !== '/api/steward/mcp')
      // 各端点都真的经过客户端；新增接口漏写文档、漏写调用、混入个人或异空间路径均报错。
      for (const c of calls) {
        expect(c.path.startsWith(prefix + '/'), c.path).toBe(true)
        expect(c.headers['x-takt-user'], c.path).toBe(user)
        expect(documented.some(r => r.method === c.method && r.re.test(strip(c.path))), c.path).toBe(true)
        expect(() => validateWriteRequest(asRequest(c)), c.path).not.toThrow()
        if (c.method !== 'GET') expect(c.body, c.path).toBeTruthy()
      }
      for (const r of documented) expect(calls.some(c => c.method === r.method && r.re.test(strip(c.path))), r.method + ' ' + r.path).toBe(true)
    } finally {
      off()
      offFeed()
    }
  })
})
