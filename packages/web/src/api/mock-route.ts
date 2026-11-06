/**
 * 路由卡演示（docs/design/19 §1）：每个流水线运行带一张 RouteDecision；预览接口按启发式算，改档留痕。
 * 档位只看改动形状：T0 已写死 / T1 单一改动面 / T2 多面串行 / T3 多面不相交并行。
 */
import type { Actor, RouteDecision, RoutePreviewRequest, Tier } from '@taktflow/core'
import type { MockDb } from './mock-data'

const LEAD: Actor = { type: 'agent', role: 'lead', harness: 'claude-code', model: 'sonnet' }
const STANDARD_GATES = ['PRD 交叉评审', '系分门禁', '系分交叉评审', '用例评审', '追溯对齐', '代码评审', '交付校验']
const STANDARD_ROLES = ['pm', 'architect', 'test-designer', 'dev', 'automation', 'reviewer', 'judge']
const QUICK_GATES = ['代码评审', '交付校验']
const QUICK_ROLES = ['pm', 'dev', 'reviewer', 'verifier']

/** 各档默认流程（与 docs/design/19 的档位表一致）。 */
export const TIER_WORKFLOW: Record<Tier, string> = { T0: 'quick-fix', T1: 'quick-fix', T2: 'sdlc', T3: 'sdlc' }

export function routeOf(tier: Tier, opts: { reason: string; surfaces: RouteDecision['surfaces']; at: string; adjustments?: string[]; overridden?: RouteDecision['overridden'] }): RouteDecision {
  const quick = TIER_WORKFLOW[tier] === 'quick-fix'
  return {
    tier,
    workflowId: TIER_WORKFLOW[tier],
    reason: opts.reason,
    surfaces: opts.surfaces,
    gates: quick ? (tier === 'T0' ? ['交付校验'] : QUICK_GATES) : STANDARD_GATES,
    roles: quick ? QUICK_ROLES : STANDARD_ROLES,
    adjustments: opts.adjustments,
    decidedBy: LEAD,
    at: opts.at,
    overridden: opts.overridden,
  }
}

/** 演示数据里各需求的路由结果（运行开始时写入 RunState.route）。 */
export function seedRoutes(): Record<string, Omit<Parameters<typeof routeOf>[1], 'at'> & { tier: Tier }> {
  return {
    'REQ-001': { tier: 'T2', reason: '改 greet() 本体，CLI 与 HTTP 两个入口依赖它的行为，必须先改核心再改入口。', surfaces: [{ id: 'core', paths: ['src/greet.js'], repo: 'shop-api' }, { id: 'entry', paths: ['cli/**', 'server/routes/greet.js'], repo: 'shop-api' }] },
    'REQ-002': {
      tier: 'T2',
      reason: '导出接口、CSV 写出、前端按钮三个改动面；CSV 写出依赖导出接口的任务模型。',
      surfaces: [{ id: 'export-api', paths: ['src/export/**', 'src/orders/**'], repo: 'shop-api' }, { id: 'csv-writer', paths: ['src/export/csv.ts', 'src/export/stream.ts'], repo: 'shop-api' }, { id: 'export-ui', paths: ['src/pages/orders/**'], repo: 'shop-web' }],
      adjustments: ['模型给的 T3，但 export-api 与 csv-writer 的路径相交（src/export/**），降为 T2：研发任务串行。'],
    },
    'REQ-003': { tier: 'T2', reason: '登录接口与前端登录页两个改动面，前端依赖接口新增的 NEED_CAPTCHA 错误码。', surfaces: [{ id: 'login-api', paths: ['src/auth/**'], repo: 'shop-api' }, { id: 'login-page', paths: ['src/pages/login/**'], repo: 'shop-web' }] },
    'REQ-004': { tier: 'T2', reason: '定时扫描任务与消息模板两个改动面，模板依赖扫描任务的数据结构。', surfaces: [{ id: 'scanner', paths: ['src/coupon/remind/**'], repo: 'shop-api' }, { id: 'template', paths: ['templates/notify/coupon-*.md'], repo: 'shop-api' }] },
    'REQ-007': { tier: 'T1', reason: '只改导出服务里文件名的日期格式，一个改动面（src/export/filename.ts），不涉及接口和数据。', surfaces: [{ id: 'filename', paths: ['src/export/filename.ts', 'test/export/filename.test.ts'], repo: 'shop-api' }] },
  }
}

/** 预览：给了 tier 就按人指定的档位（留痕），否则沿用该需求最近一次路由，没有时按标题启发式。 */
export function previewRoute(db: MockDb, requirementId: string, body: RoutePreviewRequest): RouteDecision | string {
  const req = db.requirements.find((r) => r.id === requirementId)
  if (!req) return `需求 ${requirementId} 不存在`
  if (body.tier && !body.reason?.trim()) return '改档需要写原因'
  const at = new Date().toISOString()
  const prev = [...db.runs.values()]
    .filter((r) => r.state.requirementId === requirementId && r.state.route)
    .sort((a, b) => Date.parse(b.state.startedAt) - Date.parse(a.state.startedAt))[0]?.state.route
  const seeded = seedRoutes()[requirementId]
  const guess: Tier = prev?.tier ?? seeded?.tier ?? (/文案|格式|文件名|颜色|拼写/.test(req.title + (body.hint ?? '')) ? 'T1' : 'T2')
  const surfaces = prev?.surfaces ?? seeded?.surfaces ?? [{ id: 'main', paths: ['src/**'] }]
  if (!body.tier || body.tier === guess) {
    return routeOf(guess, { reason: prev?.reason ?? seeded?.reason ?? `按标题「${req.title}」判断：${guess === 'T1' ? '单一改动面' : '多个改动面且有先后依赖'}。`, surfaces, at, adjustments: prev?.adjustments ?? seeded?.adjustments })
  }
  const adjustments: string[] = []
  let tier = body.tier
  // 确定性校验：T3 要求改动面路径两两不相交
  if (tier === 'T3' && overlaps(surfaces)) {
    adjustments.push('改动面路径相交，T3 降为 T2：研发任务串行。')
    tier = 'T2'
  }
  if ((tier === 'T0' || tier === 'T1') && surfaces.length > 1) adjustments.push(`当前识别到 ${surfaces.length} 个改动面，${tier} 只覆盖第一个（${surfaces[0]!.id}），其余需另开需求。`)
  return routeOf(tier, {
    reason: body.reason!,
    surfaces: tier === 'T0' || tier === 'T1' ? surfaces.slice(0, 1) : surfaces,
    at,
    adjustments: adjustments.length ? adjustments : undefined,
    overridden: { by: { type: 'human', id: 'web' }, reason: body.reason!, from: guess },
  })
}

/** 静态前缀互为前缀即视为相交（与 core 的 glob 交集口径一致的简化版）。 */
function overlaps(surfaces: RouteDecision['surfaces']): boolean {
  const prefix = (g: string) => g.split(/[*?[{]/)[0]!
  for (let i = 0; i < surfaces.length; i++)
    for (let j = i + 1; j < surfaces.length; j++)
      for (const a of surfaces[i]!.paths)
        for (const b of surfaces[j]!.paths) {
          const pa = prefix(a)
          const pb = prefix(b)
          if (pa.startsWith(pb) || pb.startsWith(pa)) return true
        }
  return false
}
