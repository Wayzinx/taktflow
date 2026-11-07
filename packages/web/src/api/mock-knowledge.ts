/**
 * 知识库演示数据源（每个空间一份；只有 hello-delivery 有种子数据，其他空间展示空状态）。
 * 构建进度会动：业务 Wiki 的 generate 阶段每 0.8 秒前进一格，完成后进入索引、成功并产出候选版本。
 */
import type { KnowledgeBaseDetail, KnowledgeBaseSummary, KnowledgeBuild, KnowledgeEvalCase, KnowledgeEvalRun, KnowledgeQueryResponse } from '@taktflow/core'
import { GATE_FAIL_REASONS, KINDS, mockTest, seedBases, seedBindings, seedBuilds, seedEvalCases, seedEvalRuns } from './mock-knowledge-seed'
import type { KnowledgeSource } from './source-m4'

const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 110): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
const fail = (status: number, msg: string) => Promise.reject(Object.assign(new Error(msg), { status }))
const now = () => new Date().toISOString()
const day = (d: number) => new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10)

export function createMockKnowledge(seeded: boolean): KnowledgeSource {
  const bases: KnowledgeBaseSummary[] = seeded ? seedBases() : []
  let bindings = seeded ? seedBindings() : []
  const builds: KnowledgeBuild[] = seeded ? seedBuilds() : []
  // 评测用例按知识库分开存：baseId → setId → 用例
  const casesByBase: Record<string, Record<string, KnowledgeEvalCase[]>> = seeded ? { 'shop-docs': seedEvalCases() } : {}
  const casesOf = (baseId: string) => (casesByBase[baseId] ??= {})
  const setTitle = (id: string) => (id === 'es-core' ? '核心用例' : id === 'es-online' ? '线上采集' : id)
  const runs: KnowledgeEvalRun[] = seeded ? seedEvalRuns() : []
  const secrets = seeded ? ['orders-ro', 'open-platform-token'] : []
  const buildSubs = new Map<string, Set<(b: KnowledgeBuild) => void>>()

  const find = (id: string) => bases.find((b) => b.id === id)
  const need = <T,>(id: string, fn: (b: KnowledgeBaseSummary) => T | Promise<T>): Promise<T> => {
    const b = find(id)
    return b ? Promise.resolve(fn(b)) : fail(404, `知识库 ${id} 不存在`)
  }

  /** 推进一次运行中的构建；结束时更新知识库状态。 */
  function tick(build: KnowledgeBuild) {
    if (build.status !== 'running') return
    const cur = build.stages.find((s) => s.status === 'running') ?? build.stages.find((s) => s.status === 'todo')
    if (!cur) {
      Object.assign(build, { status: 'succeeded', endedAt: now() })
      const b = find(build.baseId)
      if (b) Object.assign(b, { status: 'ready', candidateVersion: build.version, builtAt: now(), building: undefined })
    } else {
      cur.status = 'running'
      cur.done = Math.min(cur.total, cur.done + Math.max(1, Math.round(cur.total / 14)))
      if (cur.done >= cur.total) cur.status = 'done'
      build.log = [...build.log.slice(-199), `${cur.title} ${cur.done}/${cur.total}`]
      const b = find(build.baseId)
      if (b) b.building = { buildId: build.id, stage: cur.id, done: cur.done, total: cur.total }
    }
    buildSubs.get(build.id)?.forEach((f) => f(clone(build)))
  }
  setInterval(() => builds.forEach(tick), 800)

  const detail = (b: KnowledgeBaseSummary): KnowledgeBaseDetail => {
    const sets = Object.entries(casesOf(b.id)).map(([id, list]) => ({ id, title: setTitle(id), total: list.length, bySource: list.reduce<Record<string, number>>((m, x) => ((m[x.source] = (m[x.source] ?? 0) + 1), m), {}), candidates: list.filter((x) => x.status === 'candidate').length }))
    const q = b.usage7d.queries
    return {
      ...b,
      bindings: bindings.filter((x) => x.baseId === b.id).map((x) => ({ ...x, spaceId: 'hello-delivery' })),
      builds: builds.filter((x) => x.baseId === b.id),
      evalSets: sets,
      usage: {
        byNode: q ? [{ workflowId: 'sdlc', nodeId: 'design', queries: Math.round(q * 0.42), citedRate: 0.66 }, { workflowId: 'sdlc', nodeId: 'implement', queries: Math.round(q * 0.35), citedRate: 0.58 }, { workflowId: 'quick-fix', nodeId: 'spec', queries: Math.round(q * 0.23), citedRate: 0.49 }] : [],
        recent: q ? [{ at: now(), requirementId: 'REQ-002', runId: 'run-20261104-0002', nodeId: 'implement', query: 'CSV 导出 BOM 约定', hits: 5, cited: true, latencyMs: 132, via: 'tool' }, { at: now(), requirementId: 'REQ-003', nodeId: 'design', query: '验证码过期时间', hits: 0, cited: false, latencyMs: 98, via: 'prefetch' }] : [],
        trend: Array.from({ length: 7 }, (_, i) => ({ date: day(6 - i), queries: Math.round(q / 7 + (i % 3) * 12), hitRate: b.usage7d.hitRate - 0.03 + i * 0.008, emptyRate: b.usage7d.emptyRate, citedRate: b.usage7d.citedRate })),
      },
    }
  }

  function query(b: KnowledgeBaseSummary, text: string, topK: number): KnowledgeQueryResponse {
    const blocked = /删除|delete|drop|update/i.test(text) ? '只读守卫：语句包含写操作，已拦截' : undefined
    const hits = blocked ? [] : Array.from({ length: Math.min(topK, 5) }, (_, i) => {
      const bm25 = Math.max(0.1, 0.82 - i * 0.13)
      const vector = Math.max(0.1, 0.9 - i * 0.09)
      return { sourceId: b.id, baseId: b.id, version: b.version, rank: i + 1, title: ['退款接口 · 幂等', '金额格式约定', 'CSV 导出规范', '订单状态机', '发布流程'][i]!, ref: ['docs/api/refund.md#idempotency', 'docs/conventions/money.md', 'docs/conventions/csv.md', 'docs/domain/order-status.md', 'docs/ops/release.md'][i]!, snippet: `……与「${text.slice(0, 12)}」相关的段落，第 ${i + 1} 条命中……`, score: Math.round((bm25 * 0.4 + vector * 0.6) * 1000) / 1000, scores: { bm25, vector, rerank: Math.max(0.05, 0.95 - i * 0.17) }, evidenceLevel: i === 4 ? ('stale' as const) : ('verified' as const), content: `## 原文\n\n这是 ${b.name} 中与问题相关的原文片段（演示数据）。` }
    })
    const executed = b.kind === 'database' ? { kind: 'sql' as const, text: blocked ? `DELETE FROM orders WHERE …` : `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'orders' LIMIT ${topK}`, blocked } : b.kind === 'api' ? { kind: 'http' as const, text: 'GET https://open.example.com/v2/orders/{id}  Authorization: secret:open-platform-token', blocked } : undefined
    return { hits, latencyMs: 120 + Math.round(Math.random() * 80), tokens: hits.length * 310, intent: b.intents[0]!, executed }
  }

  return {
    knowledgeKinds: () => delay(KINDS, 80),
    knowledgeBases: () => delay(bases, 140),
    createKnowledgeBase(body) {
      const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `kb-${bases.length + 1}`
      if (find(id)) return fail(409, `知识库 ${id} 已存在`)
      const b: KnowledgeBaseSummary = { id, name: body.name, kind: body.kind, description: body.description ?? '', intents: body.intents ?? KINDS.find((k) => k.kind === body.kind)?.intents ?? [], scope: body.scope ?? 'space', config: body.config, retrieval: { topK: 8, budgetTokens: 2400, ...body.retrieval }, status: 'draft', version: 0, createdAt: now(), updatedAt: now(), createdBy: { type: 'human', id: 'wayne' }, bound: body.bind !== false, usage7d: { queries: 0, hitRate: 0, citedRate: 0, emptyRate: 0 } }
      bases.push(b)
      if (b.bound) bindings.push({ baseId: id, scope: b.scope, enabled: true, priority: bindings.length + 1 })
      return delay(b, 300)
    },
    knowledgeBase: (id) => need(id, (b) => delay(detail(b), 160)),
    updateKnowledgeBase: (id, body) =>
      need(id, (b) => {
        if (!body.reason?.trim()) return fail(400, 'reason 必须是非空字符串')
        // 改了数据源配置：旧候选版本作废，需要重新构建
        const reset = body.config !== undefined && JSON.stringify(body.config) !== JSON.stringify(b.config)
        Object.assign(b, { ...body, reason: undefined, updatedAt: now() }, reset ? { candidateVersion: undefined, status: b.version ? 'ready' : 'draft' } : {})
        return delay(b)
      }),
    deleteKnowledgeBase: (id, reason) => need(id, () => (reason.trim() ? (bases.splice(bases.findIndex((b) => b.id === id), 1), (bindings = bindings.filter((x) => x.baseId !== id)), delay(undefined)) : fail(400, 'reason 必须是非空字符串'))),
    testKnowledgeBase: (id) => need(id, (b) => delay(mockTest(b), 900)),
    uploadKnowledge: (id, body) => need(id, () => delay({ docs: body.files.length }, 500)),
    knowledgeDocs: (id) => need(id, (b) => delay(Array.from({ length: Math.min(12, b.stats?.docs ?? 0) }, (_, i) => ({ path: `docs/section-${i + 1}.md`, bytes: 4000 + i * 731, updatedAt: now(), indexed: i % 5 !== 4 })))),
    startKnowledgeBuild: (id, reason) =>
      need(id, (b) => {
        if (!reason.trim()) return fail(400, 'reason 必须是非空字符串')
        if (builds.some((x) => x.baseId === id && x.status === 'running')) return fail(409, '已有一次构建在进行中')
        const build: KnowledgeBuild = { id: `kb-b-${id}-${Date.now().toString(36)}`, baseId: id, version: Math.max(b.version, b.candidateVersion ?? 0) + 1, status: 'running', startedAt: now(), by: { type: 'human', id: 'wayne' }, stages: [{ id: 'parse', title: '解析', done: 0, total: b.stats?.docs || 40, status: 'running' }, { id: 'chunk', title: '切块', done: 0, total: b.stats?.chunks || 320, status: 'todo' }, { id: 'embed', title: '嵌入', done: 0, total: b.stats?.chunks || 320, status: 'todo' }, { id: 'index', title: '索引', done: 0, total: b.stats?.chunks || 320, status: 'todo' }], log: ['开始构建'] }
        builds.unshift(build)
        b.status = 'building'
        b.building = { buildId: build.id, stage: build.stages[0]!.id, done: 0, total: build.stages[0]!.total }
        return delay(build, 200)
      }),
    knowledgeBuild: (id, buildId) => need(id, () => builds.find((x) => x.id === buildId) ?? fail(404, `构建 ${buildId} 不存在`)).then(clone),
    subscribeKnowledgeBuild(_id, buildId, on) {
      let set = buildSubs.get(buildId)
      if (!set) buildSubs.set(buildId, (set = new Set()))
      set.add(on)
      return () => set!.delete(on)
    },
    cancelKnowledgeBuild: (id, buildId) =>
      need(id, (b) => {
        const build = builds.find((x) => x.id === buildId)
        if (!build) return fail(404, `构建 ${buildId} 不存在`)
        Object.assign(build, { status: 'cancelled', endedAt: now() })
        Object.assign(b, { status: b.version ? 'ready' : 'draft', building: undefined })
        buildSubs.get(buildId)?.forEach((f) => f(clone(build)))
        return delay(build)
      }),
    queryKnowledge: (id, body) => need(id, (b) => delay(query(b, body.text, body.topK ?? b.retrieval.topK), 260)),
    publishKnowledge: (id, body) =>
      need(id, (b) => {
        if (!body.reason?.trim()) return fail(400, 'reason 必须是非空字符串')
        // 与服务端一致：需要构建的类型必须有成功的候选版本；不需要构建的类型不带 version 时现构建一个
        if (!body.version && !b.candidateVersion && KINDS.find((k) => k.kind === b.kind)?.needsBuild !== false) return fail(409, '没有成功的候选版本，请先构建')
        const gateFails = b.id === 'shop-docs' && (body.version ?? b.candidateVersion) === 4
        if (gateFails && !body.force) return delay({ base: b, gate: { pass: false, reasons: GATE_FAIL_REASONS, evalRunId: 'kr-12' } }, 400)
        Object.assign(b, { version: body.version ?? b.candidateVersion ?? b.version + 1, candidateVersion: undefined, publishedAt: now(), status: 'ready' })
        return delay({ base: b, gate: { pass: !gateFails, reasons: gateFails ? GATE_FAIL_REASONS : [], evalRunId: gateFails ? 'kr-12' : undefined } }, 400)
      }),
    knowledgeEvalSets: (id) => need(id, (b) => delay(Object.entries(casesOf(b.id)).map(([setId, list]) => ({ id: setId, title: setTitle(setId), cases: list })))),
    saveKnowledgeEvalCases: (id, setId, next) =>
      need(id, () => {
        const list = (casesOf(id)[setId] ??= [])
        for (const n of next) {
          const i = list.findIndex((x) => x.id === n.id)
          if (i >= 0) list[i] = clone(n)
          else list.push(clone(n))
        }
        return delay(list)
      }),
    synthesizeKnowledgeCases: (id, setId, count) => need(id, () => synth(id, setId, count, 'synthetic')),
    harvestKnowledgeCases: (id, setId) => need(id, () => synth(id, setId, 3, 'harvested')),
    knowledgeEvalRuns: (id) => need(id, () => delay(runs.filter((r) => r.baseId === id))),
    startKnowledgeEvalRun: (id, body) =>
      need(id, () => {
        const done = runs.find((r) => r.id === 'kr-12')!
        const run: KnowledgeEvalRun = { ...clone(done), id: `kr-${runs.length + 13}`, baseId: id, setId: body.setId, variants: body.variants, status: 'running', startedAt: now(), endedAt: undefined, metrics: {}, perCase: [], comparison: undefined }
        runs.unshift(run)
        setTimeout(() => Object.assign(run, { status: 'done', endedAt: now(), metrics: Object.fromEntries(body.variants.map((v, i) => [v.id, Object.values(done.metrics)[Math.min(i, 1)]!])), perCase: done.perCase, comparison: body.variants.length > 1 ? { ...done.comparison!, baseline: body.variants[0]!.id, candidate: body.variants[1]!.id } : undefined }), 2400)
        return delay(run, 200)
      }),
    knowledgeEvalRun: (id, runId) => need(id, () => runs.find((r) => r.id === runId) ?? fail(404, `评测 ${runId} 不存在`)).then(clone),
    knowledgeBindings: () => delay(bindings),
    saveKnowledgeBindings: (next, reason) => {
      if (!reason.trim()) return fail(400, 'reason 必须是非空字符串')
      bindings = clone(next)
      for (const b of bases) b.bound = bindings.some((x) => x.baseId === b.id && x.enabled !== false)
      return delay(bindings, 200)
    },
    knowledgeSecrets: () => delay(secrets),
    putKnowledgeSecret: (name) => (secrets.includes(name) || secrets.push(name), delay({ name }, 200)),
    migrateKnowledge: (dryRun) => delay({ applied: !dryRun, items: [{ id: 'wiki', kind: 'wiki', to: 'llm-wiki', ok: true, message: '迁移为 llm-wiki（来源：knowledge/wiki/）' }, { id: 'orders-db', kind: 'db-schema', to: 'database', ok: true, message: '迁移为 database，连接串改为密钥引用 secret:orders-ro' }, { id: 'codegraph', kind: 'codegraph', ok: false, message: '代码图谱插件未安装，保留旧配置' }] }, 500),
  }

  function synth(baseId: string, setId: string, count: number, source: KnowledgeEvalCase['source']): Promise<KnowledgeEvalCase[]> {
    const list = (casesOf(baseId)[setId] ??= [])
    const added = Array.from({ length: count }, (_, i): KnowledgeEvalCase => ({ id: `kc-${source[0]}-${Date.now().toString(36)}-${i}`, query: `${source === 'synthetic' ? '合成' : '线上'}问题 ${list.length + i + 1}`, relevant: [{ ref: 'docs/api/refund.md', grade: 2 }], source, status: 'candidate', createdAt: now(), createdBy: { type: 'agent', role: 'steward', harness: 'native' } }))
    list.push(...added)
    return delay(added, 1200)
  }
}
