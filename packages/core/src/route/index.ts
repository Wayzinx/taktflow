import { globsOverlap } from '../util/glob.js'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, RouteDecision, SnapshotNode, Tier, WorkflowSnapshot } from '../types.js'
import { validateSchema } from '../engine/schema.js'
import { runStructured } from '../engine/structured.js'
import type { HarnessAdapter } from '../types.js'

export interface RouteInput {
  stores: ProjectStores
  requirementId?: string
  draft?: { title: string; description?: string }
  hint?: string
  repos?: string[]
  workflows: Array<{ id: string; snapshot: WorkflowSnapshot }>
  model?: (prompt: string, schema: object) => Promise<unknown>
  by: Actor
  override?: { tier: Tier; reason: string }
}
const tiers = ['T0', 'T1', 'T2', 'T3']
const schema = { type: 'object', required: ['tier', 'surfaces', 'reason'], properties: {
  tier: { type: 'string', enum: tiers }, reason: { type: 'string' }, workflowId: { type: 'string' },
  surfaces: { type: 'array', items: { type: 'object', required: ['id', 'paths'], properties: {
    id: { type: 'string' }, repo: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } },
  } } },
} }

// 保守判断：通配符之前的静态前缀相交，就不能保证并行写入安全。
export const pathsOverlap = globsOverlap
function overlap(surfaces: RouteDecision['surfaces']): boolean {
  return surfaces.some((a, index) => surfaces.slice(index + 1).some((b) =>
    !(a.repo && b.repo && a.repo !== b.repo) && a.paths.some((x) => b.paths.some((y) => pathsOverlap(x, y)))))
}
const small = /文案|拼写|错别字|typo|文件名|颜色|样式微调|格式|改个|小改|只改|仅改|hotfix|修复|bug|崩溃|报错/i
const keywordSurfaces: Array<[RegExp, string, string]> = [
  // 英文缩写要求词边界：build、rapid、click 里的 ui / api / cli 不是改动面。
  [/前端|页面|按钮|弹窗|交互|\bUI\b|样式/i, 'frontend', '前端'],
  [/接口|\bAPIs?\b|服务端|后端|网关/i, 'api', '接口'],
  [/数据库|表结构|迁移|索引|SQL/i, 'data', '数据'],
  [/定时|任务|消息|通知|推送|队列/i, 'async', '异步任务'],
  [/\bCLI\b|命令行|脚本/i, 'cli', '命令行'],
  [/客户端|\biOS\b|Android|小程序/i, 'client', '客户端'],
]
const parallel = /互不|独立|并行|各自|分别/
// T0 只认给定的补丁：```diff / ```patch 代码块或 git diff 正文（docs/design/19 §1）。
const patches = /```(?:diff|patch)[^\n]*\n[\s\S]*?```|^diff --git .*?(?:\r?\n(?:diff --git .*|index .*|--- .*|\+\+\+ .*|@@.*|[ +\-\\].*|(?:new|deleted) file mode .*|(?:old|new) mode .*|(?:rename|copy) (?:from|to) .*|similarity index .*))*$/gm
// 只有补丁标记还不够；T0 限制为一个文件、至多 40 行实际增删，避免大补丁绕过评审。
function hasSmallPatch(text: string): boolean {
  const chunks = [...new Set([...text.matchAll(patches)].map(([patch]) => patch))]
  const changes = chunks.join('\n').split(/\r?\n/).filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+) /.test(line)).length
  return chunks.length > 0 && changes > 0 && changes <= 40 && new Set(splitPatches(text).files).size <= 1
}
/** 补丁正文是代码：只取它改到的文件当改动面，+/- 行里的词不算需求描述。 */
function splitPatches(text: string): { prose: string; files: string[] } {
  const files: string[] = []
  const prose = text.replace(patches, (patch) => {
    for (const [, a, b] of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) files.push(a!, b!)
    for (const [, path] of patch.matchAll(/^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/gm)) if (path !== '/dev/null') files.push(path!)
    return '\n'
  })
  return { prose, files }
}
function heuristic(raw: string, repos: string[]): Pick<RouteDecision, 'tier' | 'surfaces' | 'reason'> {
  const patched = hasSmallPatch(raw)
  const { prose: text, files } = splitPatches(raw)
  const roots = new Set([...text.matchAll(/(?:^|[\s`"'(（，、])((?:[\w.-]+\/)+[\w.*?/-]*)/g)].map((match) => match[1]!.replace(/^\.\//, '').split('/')[0]!).filter(Boolean))
  for (const file of files) if (file.includes('/')) roots.add(file.split('/')[0]!)
  for (const repo of repos) if (new RegExp(`(^|[^\\w-])${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(text)) roots.add(repo)
  const surfaces: Array<RouteDecision['surfaces'][number] & { label?: string }> = [
    ...[...roots].map((id) => ({ id, paths: [`${id}/**`], ...(repos.includes(id) ? { repo: id } : {}) })),
    ...keywordSurfaces.filter(([re]) => re.test(text)).map(([, id, label]) => ({ id, paths: [], label })),
  ]
  const byId = [...new Map(surfaces.map((surface) => [surface.id, surface])).values()]
  const labels = byId.map((surface) => 'label' in surface ? surface.label : surface.id)
  let tier: Tier
  if (patched && byId.length <= 1) tier = 'T0'
  else if (small.test(text) && byId.length <= 1) tier = 'T1'
  else if (parallel.test(text) && roots.size >= 2 && byId.length === roots.size) tier = 'T3'
  else if (byId.length >= 2) tier = 'T2'
  else tier = 'T2'
  return {
    tier,
    surfaces: byId.map(({ label: _label, ...surface }) => surface),
    reason: tier === 'T0'
      ? '已给出补丁且只动一处，按补丁实现并校验'
      : tier === 'T1'
        ? (labels.length ? `看起来只动${labels[0]}一处，使用轻量流程` : '描述像一处小改动，使用轻量流程')
        : tier === 'T3'
          ? '多个路径改动面声明可并行且路径可证明不相交'
          : byId.length ? `涉及${labels.join('、')}，按标准流程推进` : '范围还不清楚，按标准流程推进',
  }
}
const flatten = (nodes: SnapshotNode[]): SnapshotNode[] => nodes.flatMap((node) => [node, ...flatten(node.body ?? [])])
/** 空间里没有能接这个需求的流水线：是空间配置问题，调用方按冲突（409）提示人去处理，不是服务器错误。 */
export class RouteUnavailableError extends Error {}

export async function routeRequirement(input: RouteInput): Promise<RouteDecision> {
  const { stores, workflows, by } = input
  const requirement = input.draft ?? (input.requirementId ? await stores.workspaces.getRequirement(input.requirementId) : undefined)
  if (!requirement) throw new Error(`需求不存在：${input.requirementId ?? ''}`)
  if (!workflows.length) throw new RouteUnavailableError('这个空间还没有可用的流水线：先到「流水线」页新建，或从模板导入')
  const prompt = [
    '按改动形状路由：T0 需求里已给出补丁（diff / patch）且只动一处；T1 单面；T2 多面串行；T3 多面且路径不相交。只输出指定 JSON。',
    JSON.stringify({ requirement, hint: input.hint, workflows: workflows.map(({ id, snapshot }) => ({ id, useWhen: snapshot.useWhen, tiers: snapshot.tiers })) }),
  ].join('\n')
  const model = input.model
  const adapter: HarnessAdapter = { id: 'route', displayName: '路由模型', available: async () => ({ ok: true }), run: async request => {
    const value = await model!(request.prompt, schema)
    return typeof value === 'string' ? { ok: true, finalText: value } : { ok: true, finalText: JSON.stringify(value) ?? '', structured: value }
  } }
  const text = `${requirement.title}\n${'description' in requirement ? requirement.description ?? '' : ''}\n${input.hint ?? ''}`
  const observed = heuristic(text, input.repos ?? stores.config.repos?.map((repo) => repo.id) ?? [])
  const proposed = model ? (await runStructured(adapter, { prompt, cwd: stores.projectDir, readOnly: true }, schema, { repairs: stores.config.output?.repairs })).data : observed
  validateSchema(proposed, schema)
  const proposal = proposed as Pick<RouteDecision, 'tier' | 'surfaces' | 'reason'> & { workflowId?: string }
  let tier = proposal.tier
  const adjustments: string[] = []
  if (input.override) {
    if (!tiers.includes(input.override.tier) || !input.override.reason.trim()) throw new Error('改档必须提供合法档位和原因')
    tier = input.override.tier
  }
  // 模型漏报改动面时，文本里确定识别出的多面仍然约束轻量流程；人工改档也不能绕过。
  const surfaceCount = Math.max(proposal.surfaces.length, observed.surfaces.length)
  if ((tier === 'T0' || tier === 'T1') && surfaceCount >= 2) {
    adjustments.push(`${tier} 只适用于单一改动面，这次涉及 ${surfaceCount} 个，改为 T2`)
    tier = 'T2'
  }
  if (tier === 'T0' && !hasSmallPatch(text)) {
    adjustments.push('需求里没有给出单文件小补丁，T0 改为 T1')
    tier = 'T1'
  }
  const unproven = proposal.surfaces.length < 2 || proposal.surfaces.some((surface) => !surface.paths.length || surface.paths.some((path) => !path.trim()))
  if (tier === 'T3' && (unproven || overlap(proposal.surfaces))) {
    tier = 'T2'
    adjustments.push('改动面路径相交或不足以证明两两不相交，T3 降为 T2')
  }
  const supported = ({ snapshot }: RouteInput['workflows'][number]) => !snapshot.tiers || snapshot.tiers.includes(tier)
  const requested = workflows.find((workflow) => workflow.id === proposal.workflowId)
  if (proposal.workflowId && (!requested || !supported(requested))) adjustments.push(`流程 ${proposal.workflowId} 不存在或不支持 ${tier}，已改选`)
  const selected = (requested && supported(requested) ? requested : undefined)
    ?? workflows.find((workflow) => workflow.snapshot.tiers?.includes(tier))
    ?? workflows.find((workflow) => workflow.id === stores.config.route?.defaultWorkflow && supported(workflow))
    ?? workflows.find((workflow) => workflow.id === 'taktflow-standard' && supported(workflow))
    ?? workflows.find(supported)
  if (!selected) throw new RouteUnavailableError(`没有支持 ${tier} 的流水线（现有：${workflows.map(({ id, snapshot }) => `${id} 支持 ${snapshot.tiers?.join('/')}`).join('、')}）；可以手动选择流程或改档，或在流水线的 tiers 里加上 ${tier}`)
  const nodes = flatten(selected.snapshot.nodes)
  const roles = nodes.flatMap((node) => [node.role, ...(node.allowedRoles ?? []), ...(node.checks?.map((check) => check.role) ?? []), node.review?.author,
    ...(node.review?.reviewers.map((reviewer) => reviewer.role) ?? []), node.review?.arbiter?.role]).filter((role): role is string => Boolean(role))
  return { tier, workflowId: selected.id, reason: input.override?.reason ?? proposal.reason, surfaces: observed.surfaces.length > proposal.surfaces.length ? observed.surfaces : proposal.surfaces,
    gates: nodes.filter((node) => ['gate', 'review', 'human'].includes(node.kind)).map((node) => node.title), roles: [...new Set(roles)],
    adjustments, decidedBy: by, at: new Date().toISOString(),
    ...(input.override ? { overridden: { by, reason: input.override.reason, from: proposal.tier } } : {}),
  }
}
