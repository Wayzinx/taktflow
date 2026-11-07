/**
 * 知识库演示数据（docs/design/23）：5 个知识库——商城文档（rag，ready）、业务 Wiki（llm-wiki，构建中）、
 * 订单库（database，ready）、开放平台接口（api，草稿）、提交历史（history，ready）。
 */
import type { Actor, KnowledgeBaseSummary, KnowledgeBinding, KnowledgeBuild, KnowledgeEvalCase, KnowledgeEvalRun, KnowledgeKindInfo, KnowledgeTestResult } from '@taktflow/core'

const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()
const HUMAN: Actor = { type: 'human', id: 'wayne' }
const SYS: Actor = { type: 'system', id: 'kb-builder' }

const retrieval = { topK: 8, minScore: 0.2, hybrid: { bm25: 0.4, vector: 0.6 }, rerank: 'bge-reranker', budgetTokens: 2400 }

/**
 * 类型清单：kind / 标题 / 说明 / intents / needsBuild / configSchema 与服务端 packages/knowledge/src/kinds/* 一致
 * （test/mock-knowledge-kinds-sync.test.ts 校验）；available / reason 是演示用的可用性。
 */
export const KINDS: KnowledgeKindInfo[] = [
  { kind: 'rag', title: '文档检索', summary: '业务规则、产品文档和规范', example: '退款规则是什么？', intents: ['business', 'fact'], needsBuild: true, available: true, configSchema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['upload', 'path', 'repo', 'url'] }, path: { type: 'string' }, repo: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } } } } }, chunkTokens: { type: 'integer' }, overlapTokens: { type: 'integer' } } } },
  { kind: 'llm-wiki', title: 'LLM Wiki', summary: '模块职责、业务流程和设计原因', intents: ['business', 'history', 'impact'], needsBuild: true, available: true, configSchema: { type: 'object', properties: { source: { type: 'string', enum: ['space', 'path', 'git'] }, path: { type: 'string' }, url: { type: 'string' }, branch: { type: 'string' }, generate: { type: 'object', required: ['repo'], properties: { repo: { type: 'string' }, granularity: { type: 'string', enum: ['directory', 'module'] } } } } } },
  { kind: 'database', title: '数据库', summary: '表结构、字段口径和只读实时数据', intents: ['schema', 'fact'], needsBuild: true, available: true, configSchema: { type: 'object', required: ['driver', 'connection'], properties: { driver: { type: 'string', enum: ['sqlite', 'postgres', 'mysql'] }, connection: { type: 'string', format: 'secret' }, tables: { type: 'array', items: { type: 'string' } }, schemas: { type: 'array', items: { type: 'string' } }, rowLimit: { type: 'integer' }, notes: { type: 'object' }, mask: { type: 'object' } } } },
  { kind: 'api', title: '接口', summary: 'OpenAPI 操作检索和允许的 GET 实时查询', intents: ['fact'], needsBuild: true, available: true, configSchema: { type: 'object', required: ['openapi'], properties: { allow: { type: 'array', items: { type: 'string' } }, baseURL: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string', format: 'secret' } }, maxBytes: { type: 'integer' } } } },
  { kind: 'code', title: '代码', summary: '精确符号和代码定位', intents: ['symbol', 'impact'], needsBuild: false, available: false, reason: '需要先安装 codegraph 插件', configSchema: { type: 'object', properties: { path: { type: 'string' }, ignore: { type: 'array', items: { type: 'string' } }, repos: { type: 'array', items: { type: 'string' } } } } },
  { kind: 'history', title: '历史', summary: '提交原因和过往需求', intents: ['history', 'business'], needsBuild: false, available: true, configSchema: { type: 'object', properties: { workspacePath: { type: 'string' }, path: { type: 'string' }, source: { type: 'string', enum: ['git-history', 'workspace', 'both'] } } } },
]

/** 演示的 OpenAPI 操作（只在 mock 的"测试连接"里返回，形状同服务端 api.test 的 preview）。 */
const DEMO_OPS: Array<[string, string, string]> = [
  ['GET', '/v2/orders/{id}', '查询订单详情'], ['GET', '/v2/orders', '按条件列出订单'], ['POST', '/v2/orders/{id}/cancel', '取消订单'],
  ['GET', '/v2/refunds/{id}', '查询退款'], ['POST', '/v2/refunds', '发起退款'], ['GET', '/v2/apps/{appId}/quota', '查询调用配额'],
]
export function mockTest(b: KnowledgeBaseSummary): KnowledgeTestResult {
  if (b.kind === 'api') {
    if (!b.config.openapi) return { ok: false, message: '还没有填 OpenAPI 地址或文件' }
    return { ok: true, message: `读取 ${DEMO_OPS.length} 个操作，请勾选允许调用的 GET`, preview: DEMO_OPS.map(([m, path, title]) => ({ title, ref: `${m} ${path}`, snippet: `${m} ${path}` })) }
  }
  return { ok: true, message: `连接正常，预览前 3 项（${b.kind === 'database' ? '表' : '文档'}）`, preview: [1, 2, 3].map((i) => ({ title: `${b.name} · 示例 ${i}`, ref: `item-${i}`, snippet: '预览内容（演示数据）' })) }
}

const base = (b: Partial<KnowledgeBaseSummary> & Pick<KnowledgeBaseSummary, 'id' | 'name' | 'kind' | 'description' | 'intents' | 'status' | 'version'>): KnowledgeBaseSummary => ({
  scope: 'space',
  config: {},
  retrieval,
  createdAt: ago(30 * 24 * 60),
  updatedAt: ago(60),
  createdBy: HUMAN,
  bound: true,
  usage7d: { queries: 0, hitRate: 0, citedRate: 0, emptyRate: 0 },
  ...b,
})

export function seedBases(): KnowledgeBaseSummary[] {
  return [
    base({ id: 'shop-docs', name: '商城文档', kind: 'rag', description: '商城前后端的开发规范、接口文档与运维手册（shop-docs 仓库 docs/）', intents: ['business', 'fact'], status: 'ready', version: 3, candidateVersion: 4, builtAt: ago(25 * 60), publishedAt: ago(6 * 24 * 60), stats: { docs: 214, chunks: 1892, bytes: 3_412_000 }, config: { sources: [{ type: 'repo', repo: 'shop-docs' }], chunkTokens: 800 }, usage7d: { queries: 1240, hitRate: 0.84, citedRate: 0.61, emptyRate: 0.06 }, lastEval: { runId: 'kr-12', recall10: 0.86, at: ago(24 * 60) }, staleDocs: 7 }),
    base({ id: 'biz-wiki', name: '业务 Wiki', kind: 'llm-wiki', description: '从 shop-api 代码生成的模块级业务说明：订单、优惠券、库存', intents: ['business', 'impact'], status: 'building', version: 1, builtAt: ago(9 * 24 * 60), publishedAt: ago(9 * 24 * 60), stats: { docs: 31, chunks: 412, bytes: 640_000, pages: 31 }, config: { generate: { repo: 'shop-api', granularity: 'module' } }, usage7d: { queries: 386, hitRate: 0.77, citedRate: 0.52, emptyRate: 0.11 }, lastEval: { runId: 'kr-9', recall10: 0.79, at: ago(9 * 24 * 60) }, building: { buildId: 'kb-b-wiki-2', stage: 'generate', done: 12, total: 31 } }),
    base({ id: 'orders-db', name: '订单库', kind: 'database', description: '订单库表结构与字段口径（只读账号，18 张表白名单）', intents: ['schema', 'fact'], status: 'ready', version: 2, builtAt: ago(3 * 24 * 60), publishedAt: ago(3 * 24 * 60), stats: { docs: 18, chunks: 18, bytes: 96_000, tables: 18 }, config: { driver: 'postgres', connection: 'secret:orders-ro', schemas: ['public'], tables: ['orders', 'order_items', 'refunds'], rowLimit: 200 }, usage7d: { queries: 512, hitRate: 0.69, citedRate: 0.48, emptyRate: 0.17 }, lastEval: { runId: 'kr-11', recall10: 0.71, at: ago(26 * 60) } }),
    base({ id: 'open-api', name: '开放平台接口', kind: 'api', description: '对外开放平台的 OpenAPI（草稿，还没测试连接）', intents: ['fact'], status: 'draft', version: 0, bound: false, stats: { docs: 0, chunks: 0, bytes: 0, operations: 46 }, config: { openapi: 'https://open.example.com/openapi.json', allow: [] }, createdAt: ago(40), updatedAt: ago(40) }),
    base({ id: 'git-history', name: '提交历史', kind: 'history', description: '三个业务仓库近一年的提交与过往需求存放区', intents: ['history'], status: 'ready', version: 5, builtAt: ago(12 * 60), publishedAt: ago(12 * 60), stats: { docs: 4210, chunks: 9830, bytes: 12_800_000 }, config: { source: 'both' }, usage7d: { queries: 208, hitRate: 0.88, citedRate: 0.7, emptyRate: 0.03 }, lastEval: { runId: 'kr-10', recall10: 0.9, at: ago(5 * 24 * 60) } }),
  ]
}

export function seedBindings(): KnowledgeBinding[] {
  return [
    { baseId: 'shop-docs', scope: 'space', enabled: true, priority: 1 },
    { baseId: 'biz-wiki', scope: 'space', enabled: true, priority: 2, roles: ['pm', 'architect'] },
    { baseId: 'orders-db', scope: 'space', enabled: true, priority: 3, intents: ['schema'] },
    { baseId: 'git-history', scope: 'space', enabled: true, priority: 4 },
  ]
}

const stage = (id: string, title: string, done: number, total: number, status: 'todo' | 'running' | 'done' | 'failed' | 'skipped') => ({ id, title, done, total, status })

export function seedBuilds(): KnowledgeBuild[] {
  return [
    { id: 'kb-b-wiki-2', baseId: 'biz-wiki', version: 2, status: 'running', startedAt: ago(6), by: HUMAN, runId: 'run-kb-wiki-0002', stages: [stage('parse', '拆模块', 31, 31, 'done'), stage('generate', '逐模块生成', 12, 31, 'running'), stage('index', '索引', 0, 31, 'todo'), stage('snapshot', '快照', 0, 1, 'todo')], log: ['planner: 拆出 31 个模块', 'agent[order]: 生成 order/README.md', 'agent[coupon]: 生成 coupon/stacking.md'] },
    { id: 'kb-b-docs-4', baseId: 'shop-docs', version: 4, status: 'succeeded', startedAt: ago(25 * 60 + 4), endedAt: ago(25 * 60), by: SYS, stages: [stage('parse', '解析', 214, 214, 'done'), stage('chunk', '切块', 1892, 1892, 'done'), stage('embed', '嵌入', 1892, 1892, 'done'), stage('index', '索引', 1892, 1892, 'done')], log: ['解析 214 个文档', '切块 1892', '嵌入完成（bge-m3）', '索引写入 v4'], stats: { docs: 214, chunks: 1892, bytes: 3_412_000 } },
    { id: 'kb-b-docs-3', baseId: 'shop-docs', version: 3, status: 'failed', startedAt: ago(7 * 24 * 60), endedAt: ago(7 * 24 * 60 - 2), by: SYS, stages: [stage('parse', '解析', 209, 211, 'failed'), stage('chunk', '切块', 0, 0, 'skipped'), stage('embed', '嵌入', 0, 0, 'skipped'), stage('index', '索引', 0, 0, 'skipped')], log: ['解析 docs/ops/legacy.html 失败：编码无法识别'], errors: [{ ref: 'docs/ops/legacy.html', message: '编码无法识别（疑似 GBK）' }, { ref: 'docs/api/v0.json', message: 'JSON 解析失败：第 12 行' }] },
  ]
}

const c = (id: string, query: string, refs: string[], source: KnowledgeEvalCase['source'], status: KnowledgeEvalCase['status'] = 'active'): KnowledgeEvalCase => ({ id, query, relevant: refs.map((ref, i) => ({ ref, grade: i === 0 ? 3 : 2 })), source, status, createdAt: ago(10 * 24 * 60), createdBy: HUMAN })

export function seedEvalCases(): Record<string, KnowledgeEvalCase[]> {
  return {
    'es-core': [
      c('kc-1', '退款接口的幂等键怎么传？', ['docs/api/refund.md#idempotency'], 'manual'),
      c('kc-2', '金额字段统一保留几位小数？', ['docs/conventions/money.md'], 'manual'),
      c('kc-3', 'CSV 导出超过多少行要流式写出？', ['docs/conventions/csv.md', 'docs/api/export.md'], 'defect'),
      c('kc-4', '登录验证码多久过期？', ['docs/api/auth.md#captcha'], 'synthetic'),
      c('kc-5', '订单状态有哪些？', ['docs/domain/order-status.md'], 'synthetic', 'candidate'),
      c('kc-6', '灰度发布要先通知谁？', ['docs/ops/release.md'], 'synthetic', 'candidate'),
    ],
    'es-online': [c('kc-7', '优惠券和满减能叠加吗', ['docs/domain/coupon.md'], 'harvested'), c('kc-8', 'export 接口的 rate limit', ['docs/api/export.md#limits'], 'harvested', 'candidate'), c('kc-9', '头像上传大小限制', ['docs/api/avatar.md'], 'harvested', 'candidate')],
  }
}

const metrics = (recall10: number, mrr: number) => ({ n: 24, recall5: recall10 - 0.08, recall10, precision5: recall10 - 0.3, mrr, ndcg10: mrr + 0.05, hitRate: recall10 + 0.04, emptyRate: 0.04, latencyP50: 142, latencyP95: 388, tokensPerQuery: 1840 })

export function seedEvalRuns(): KnowledgeEvalRun[] {
  return [
    {
      id: 'kr-12',
      baseId: 'shop-docs',
      setId: 'es-core',
      variants: [
        { id: 'v3', label: '已发布 v3', version: 3 },
        { id: 'v4', label: '候选 v4', version: 4 },
      ],
      status: 'done',
      startedAt: ago(24 * 60 + 3),
      endedAt: ago(24 * 60),
      by: HUMAN,
      metrics: { v3: metrics(0.86, 0.71), v4: metrics(0.81, 0.68) },
      perCase: [
        { caseId: 'kc-1', variant: 'v4', firstRelevantRank: 1, found: ['docs/api/refund.md#idempotency'], missed: [], diagnosis: 'ok', latencyMs: 131 },
        { caseId: 'kc-2', variant: 'v4', firstRelevantRank: 6, found: ['docs/conventions/money.md'], missed: [], diagnosis: 'low_rank', latencyMs: 152 },
        { caseId: 'kc-3', variant: 'v4', found: ['docs/api/export.md'], missed: ['docs/conventions/csv.md'], diagnosis: 'not_retrieved', latencyMs: 166 },
        { caseId: 'kc-4', variant: 'v4', found: [], missed: ['docs/api/auth.md#captcha'], diagnosis: 'no_doc', latencyMs: 119 },
        { caseId: 'kc-1', variant: 'v3', firstRelevantRank: 1, found: ['docs/api/refund.md#idempotency'], missed: [], diagnosis: 'ok', latencyMs: 128 },
        { caseId: 'kc-2', variant: 'v3', firstRelevantRank: 2, found: ['docs/conventions/money.md'], missed: [], diagnosis: 'ok', latencyMs: 140 },
        { caseId: 'kc-3', variant: 'v3', firstRelevantRank: 3, found: ['docs/api/export.md', 'docs/conventions/csv.md'], missed: [], diagnosis: 'ok', latencyMs: 158 },
        { caseId: 'kc-4', variant: 'v3', found: [], missed: ['docs/api/auth.md#captcha'], diagnosis: 'no_doc', latencyMs: 117 },
      ],
      comparison: { baseline: 'v3', candidate: 'v4', wins: 3, losses: 8, ties: 13, recall10Delta: -0.05, interval: [-0.09, -0.01], verdict: 'worse' },
    },
    { id: 'kr-11', baseId: 'orders-db', setId: 'es-db', variants: [{ id: 'v2', label: '已发布 v2', version: 2 }], status: 'done', startedAt: ago(26 * 60 + 2), endedAt: ago(26 * 60), by: SYS, metrics: { v2: { ...metrics(0.71, 0.6), sqlSuccess: 0.92, resultAccuracy: 0.84, blocked: 3 } }, perCase: [] },
  ]
}

/** 发布门槛：候选版本相对已发布版本 Recall@10 下降超过 0.02、或有回归用例失败时不通过。 */
export const GATE_FAIL_REASONS = ['Recall@10 从 0.86 降到 0.81（下降 0.05，超过阈值 0.02）', '回归用例 kc-3「CSV 导出超过多少行要流式写出」在候选版本里没有召回']
