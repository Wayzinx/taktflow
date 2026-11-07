/**
 * 演示数据：需求与空间的增删改（docs/design/22 §2）。
 * 场景：4 个空间（payments / payments-legacy 原先都叫"支付中台"，已改成不同名字）+ 1 个已归档空间；多空间模式。
 */
import type { Requirement, RequirementCreateResponse, RequirementSummary, ServerInfo, SpaceSummary } from '@taktflow/core'
import type { MockDb } from './mock-data'
import type { MockSpace } from './mock-space'
import type { CrudSource } from './source-m4'
import { estimateRoute } from '../components/requirement-create/estimate'
import { routeOf, TIER_WORKFLOW } from './mock-route'

const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()
const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 140): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
const fail = (status: number, msg: string) => Promise.reject(Object.assign(new Error(msg), { status }))
const needReason = (reason: string | undefined) => (reason?.trim() ? undefined : fail(400, 'reason 必须是非空字符串'))

/** ?mockSingleSpace=1：模拟单空间模式（新建空间对话框给出原因与 multiSpaceHint）。 */
const singleSpace = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockSingleSpace') === '1'

export const MOCK_SERVER_INFO: ServerInfo = {
  version: '0.1.0',
  multiSpace: !singleSpace,
  multiSpaceHint: 'takt serve --spaces ~/work/spaces',
  steward: { configured: true, harness: 'native', model: 'claude-sonnet-4.5' },
  spaceTemplates: [
    { id: 'blank', title: '空白', description: '只有目录结构，角色、workflow 都自己配' },
    { id: 'standard', title: '标准交付流水线', description: '需求理解 → 系分 → 测分 → 研发 → 测试 → 准出，带交叉评审' },
    { id: 'quick', title: '快速修复', description: '短 spec → 实现 → 代码评审 → 交付校验，适合 T1 小改动' },
  ],
}

/** 空间卡片的统计（requirements / active 之外的字段）。 */
export const SPACE_STATS: Record<string, Pick<SpaceSummary, 'color' | 'risks' | 'pendingAttention' | 'lastActivityAt'>> = {
  'hello-delivery': { color: 'oklch(0.62 0.17 47)', risks: 4, pendingAttention: 3, lastActivityAt: ago(4) },
  'growth-lab': { color: 'oklch(0.58 0.11 155)', risks: 0, pendingAttention: 0, lastActivityAt: ago(3 * 24 * 60) },
  payments: { color: 'oklch(0.55 0.12 255)', risks: 1, pendingAttention: 1, lastActivityAt: ago(52) },
  'payments-legacy': { color: 'oklch(0.56 0.012 75)', risks: 0, pendingAttention: 0, lastActivityAt: ago(9 * 24 * 60) },
  'growth-2025': { color: 'oklch(0.54 0.12 300)', risks: 0, pendingAttention: 0, lastActivityAt: ago(40 * 24 * 60) },
}

function bareSpace(id: string, name: string, description: string, requirements: number, active: number, owner: string): MockSpace {
  return {
    seeded: false,
    files: new Map(),
    detail: { id, name, description, requirements, active, members: [{ id: owner, name: owner, role: 'owner', email: `${owner}@example.com` }], repos: [], skills: [], agents: [], workflows: [], knowledge: [] },
  }
}

/** 追加到 createMockSpaces() 之后的空间：两个原先同名、已改名的空间。 */
export function extraSpaces(): MockSpace[] {
  return [bareSpace('payments', '支付中台', '收单、退款与对账（2026 新版）', 0, 0, 'lin'), bareSpace('payments-legacy', '支付中台（旧版）', '老支付网关的维护需求，只修不改', 0, 0, 'chen')]
}
/** 已归档的空间（/spaces?archived=1）。 */
export function archivedSpaces(): MockSpace[] {
  // 与服务端一致：归档后目录（和 id）改名为 <id>@yyyymmdd-hhmmss
  const s = bareSpace('growth-2025@20251018-090000', '增长实验 2025', '上一年度的增长实验，已结束', 0, 0, 'qiao')
  return [s]
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
const ARCHIVED_RE = /^[a-z0-9][a-z0-9-]{1,39}@\d{8}-\d{6}$/
/** 服务端的归档时间戳：ISO 去掉 - 和 :，T 换成 -，取到秒。 */
export const archiveStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const baseId = (id: string) => id.split('@')[0]!

/** 空间增删改：直接改 mock-source 持有的两个数组。 */
export function createMockSpaceCrud(live: MockSpace[], archived: MockSpace[], onCreate: (sp: MockSpace) => void): Pick<CrudSource, 'createSpace' | 'updateSpace' | 'archiveSpace' | 'restoreSpace' | 'deleteSpace'> & { summary: (sp: MockSpace) => SpaceSummary; list: (archived?: boolean) => SpaceSummary[] } {
  const archivedAt = new Map<string, string>([['growth-2025@20251018-090000', ago(20 * 24 * 60)]])
  const summary = (sp: MockSpace): SpaceSummary => {
    const d = sp.detail
    const at = archivedAt.get(d.id)
    return { id: d.id, name: d.name, description: d.description, requirements: d.requirements, active: d.active, ...SPACE_STATS[baseId(d.id)], ...(d.color ? { color: d.color } : {}), ...(at ? { archived: true, archivedAt: at } : {}) }
  }
  const find = (id: string) => live.find((s) => s.detail.id === id)
  return {
    summary,
    list: (arch) => (arch ? archived : live).map(summary),
    createSpace(body) {
      if (!MOCK_SERVER_INFO.multiSpace) return fail(409, '单空间模式下不能新建空间')
      if (!ID_RE.test(body.id)) return fail(400, 'id 只能用小写字母、数字和 -，2–40 个字符')
      if ([...live, ...archived].some((s) => s.detail.id === body.id)) return fail(409, `空间 id ${body.id} 已存在`)
      if (live.some((s) => s.detail.name === body.name)) return fail(409, `已有同名空间「${body.name}」，换个名字`)
      const sp = bareSpace(body.id, body.name, body.description ?? '', 0, 0, 'wayne')
      sp.detail.color = body.color
      if (body.members?.length) sp.detail.members = clone(body.members)
      SPACE_STATS[body.id] = { color: body.color, risks: 0, pendingAttention: 0, lastActivityAt: new Date().toISOString() }
      live.push(sp)
      onCreate(sp)
      return delay(summary(sp), 420)
    },
    updateSpace(id, body) {
      const sp = find(id)
      if (!sp) return fail(404, `空间 ${id} 不存在`)
      if (body.name && live.some((s) => s.detail.id !== id && s.detail.name === body.name)) return fail(409, `已有同名空间「${body.name}」`)
      return (
        needReason(body.reason) ??
        (Object.assign(sp.detail, { ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), ...(body.color ? { color: body.color } : {}) }), delay(summary(sp)))
      )
    },
    archiveSpace(id, reason) {
      const i = live.findIndex((s) => s.detail.id === id)
      if (i < 0) return fail(404, `空间 ${id} 不存在`)
      if (live[i]!.detail.active > 0) return fail(409, `空间里还有 ${live[i]!.detail.active} 个进行中的需求，先归档或交付它们`)
      if (live.length === 1) return fail(409, '至少保留一个空间')
      const bad = needReason(reason)
      if (bad) return bad
      const sp = live.splice(i, 1)[0]!
      sp.detail.id = `${id}@${archiveStamp()}`
      archivedAt.set(sp.detail.id, new Date().toISOString())
      archived.unshift(sp)
      return delay(summary(sp))
    },
    restoreSpace(id, reason) {
      if (!ARCHIVED_RE.test(id)) return fail(400, '归档 ID 不合法，请从归档列表选择')
      const i = archived.findIndex((s) => s.detail.id === id)
      if (i < 0) return fail(404, `已归档空间 ${id} 不存在`)
      if (live.some((s) => s.detail.id === baseId(id))) return fail(409, '原空间 ID 已被占用，请先解决冲突')
      const bad = needReason(reason)
      if (bad) return bad
      const sp = archived.splice(i, 1)[0]!
      archivedAt.delete(id)
      sp.detail.id = baseId(id)
      live.push(sp)
      return delay(summary(sp))
    },
    deleteSpace(id, body) {
      if (!ARCHIVED_RE.test(id)) return fail(400, '归档 ID 不合法，请从归档列表选择')
      const i = archived.findIndex((s) => s.detail.id === id)
      if (i < 0) return fail(409, '只能彻底删除已归档的空间')
      if (body.confirm !== id) return fail(400, '确认 id 不一致')
      return needReason(body.reason) ?? (archived.splice(i, 1), delay(undefined, 260))
    },
  }
}

/** 需求增删改：作用于单个空间的 MockDb；summary 由 mock.ts 提供（与列表同一套读模型）。 */
export function createMockRequirementCrud(db: MockDb, summary: (id: string) => RequirementSummary, hasRuns: (id: string) => boolean): Pick<CrudSource, 'createRequirement' | 'updateRequirement' | 'archiveRequirement' | 'restoreRequirement' | 'deleteRequirement'> {
  const find = (id: string) => db.requirements.find((r) => r.id === id)
  const prevStatus = new Map<string, Requirement['status']>()
  const nextId = () => {
    const n = db.requirements.reduce((m, r) => Math.max(m, Number(/REQ-(\d+)/.exec(r.id)?.[1] ?? 0)), 0) + 1
    return `REQ-${String(n).padStart(3, '0')}`
  }
  return {
    createRequirement(body) {
      if (!body.title.trim()) return fail(400, '标题不能为空')
      const id = body.id ?? nextId()
      if (find(id)) return fail(409, `需求 ${id} 已存在`)
      const now = new Date().toISOString()
      db.requirements.unshift({ id, title: body.title.trim(), status: body.start === false ? 'draft' : 'active', owner: body.owner ?? 'wayne', members: body.members, links: body.links ?? [], description: body.description, dueAt: body.dueAt, createdAt: now, updatedAt: now })
      const res: RequirementCreateResponse = {
        requirement: summary(id),
        route: draftRoute(body.title, body.description, body.workflowId, now),
      }
      return delay(res, 520)
    },
    updateRequirement(id, body) {
      const r = find(id)
      if (!r) return fail(404, `需求 ${id} 不存在`)
      if (!body.reason?.trim()) return fail(400, 'reason 必须是非空字符串')
      const { reason: _reason, dueAt, ...rest } = body
      Object.assign(r, rest, { updatedAt: new Date().toISOString() })
      if (dueAt === null) delete r.dueAt
      else if (dueAt !== undefined) r.dueAt = dueAt
      return delay(summary(id))
    },
    archiveRequirement(id, reason) {
      const r = find(id)
      if (!r) return fail(404, `需求 ${id} 不存在`)
      if (summary(id).stages.some((s) => s.status === 'running')) return fail(409, '有运行中的运行，先取消再归档')
      return needReason(reason) ?? (prevStatus.set(id, r.status), Object.assign(r, { status: 'archived', archivedAt: new Date().toISOString() }), delay(summary(id)))
    },
    restoreRequirement(id, reason) {
      const r = find(id)
      if (!r) return fail(404, `需求 ${id} 不存在`)
      return needReason(reason) ?? (Object.assign(r, { status: prevStatus.get(id) ?? 'active', archivedAt: undefined }), delay(summary(id)))
    },
    deleteRequirement(id, reason) {
      const i = db.requirements.findIndex((r) => r.id === id)
      if (i < 0) return fail(404, `需求 ${id} 不存在`)
      if (hasRuns(id)) return fail(409, '这个需求已经有运行记录，只能归档')
      return needReason(reason) ?? (db.requirements.splice(i, 1), delay(undefined))
    },
  }
}

/** 新建时的路由：指定了流程就按流程定档，否则与新建对话框的草稿预估同一套规则，提示里的档位与预估一致。 */
export function draftRoute(title: string, description: string | undefined, workflowId: string | undefined, at: string) {
  const est = estimateRoute(`${title}\n${description ?? ''}`, undefined)
  const tier = workflowId ? (workflowId === 'quick-fix' || workflowId === 'hotfix' ? 'T1' : 'T2') : (est?.tier ?? 'T2')
  const r = routeOf(tier, { reason: est?.reason ?? '多个改动面且有先后依赖，走标准流水线', surfaces: [{ id: 'main', paths: ['src/**'], repo: 'shop-web' }], at })
  return { ...r, workflowId: workflowId ?? TIER_WORKFLOW[tier] }
}

