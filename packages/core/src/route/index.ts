import { globsOverlap } from '../util/glob.js'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, RouteDecision, SnapshotNode, Tier, WorkflowSnapshot } from '../types.js'
import { validateSchema } from '../engine/schema.js'

export interface RouteInput {
  stores: ProjectStores
  requirementId: string
  hint?: string
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
function heuristic(text: string, repos: string[]): Pick<RouteDecision, 'tier' | 'surfaces' | 'reason'> {
  const roots = new Set([...text.matchAll(/(?:^|[\s`"'(（，、])((?:[\w.-]+\/)+[\w.*?/-]*)/g)].map((match) => match[1]!.replace(/^\.\//, '').split('/')[0]!).filter(Boolean))
  for (const repo of repos) if (new RegExp(`(^|[^\\w-])${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(text)) roots.add(repo)
  const tier: Tier = /```(?:diff|patch)|^diff --git|只改|改成/m.test(text) ? 'T0' : roots.size > 1 ? 'T2' : 'T1'
  return { tier, surfaces: [...roots].map((id) => ({ id, paths: [`${id}/**`], ...(repos.includes(id) ? { repo: id } : {}) })),
    reason: tier === 'T0' ? '已给出明确改动指令' : tier === 'T2' ? '涉及多个改动面，默认串行' : '单一改动面，使用轻量流程' }
}
const flatten = (nodes: SnapshotNode[]): SnapshotNode[] => nodes.flatMap((node) => [node, ...flatten(node.body ?? [])])

export async function routeRequirement(input: RouteInput): Promise<RouteDecision> {
  const { stores, requirementId, workflows, by } = input
  const requirement = await stores.workspaces.getRequirement(requirementId)
  if (!requirement) throw new Error(`需求不存在：${requirementId}`)
  if (!workflows.length) throw new Error('没有可用 workflow')
  const proposed = input.model ? await input.model([
    '按改动形状路由：T0 已写死；T1 单面；T2 多面串行；T3 多面且路径不相交。只输出指定 JSON。',
    JSON.stringify({ requirement, hint: input.hint, workflows: workflows.map(({ id, snapshot }) => ({ id, useWhen: snapshot.useWhen, tiers: snapshot.tiers })) }),
  ].join('\n'), schema) : heuristic(`${requirement.title}\n${input.hint ?? ''}`, stores.config.repos?.map((repo) => repo.id) ?? [])
  validateSchema(proposed, schema)
  const proposal = proposed as Pick<RouteDecision, 'tier' | 'surfaces' | 'reason'> & { workflowId?: string }
  let tier = proposal.tier
  const adjustments: string[] = []
  if (input.override) {
    if (!tiers.includes(input.override.tier) || !input.override.reason.trim()) throw new Error('改档必须提供合法档位和原因')
    tier = input.override.tier
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
  if (!selected) throw new Error(`没有支持 ${tier} 的 workflow`)
  const nodes = flatten(selected.snapshot.nodes)
  const roles = nodes.flatMap((node) => [node.role, ...(node.allowedRoles ?? []), ...(node.checks?.map((check) => check.role) ?? []), node.review?.author,
    ...(node.review?.reviewers.map((reviewer) => reviewer.role) ?? []), node.review?.arbiter?.role]).filter((role): role is string => Boolean(role))
  return { tier, workflowId: selected.id, reason: input.override?.reason ?? proposal.reason, surfaces: proposal.surfaces,
    gates: nodes.filter((node) => ['gate', 'review', 'human'].includes(node.kind)).map((node) => node.title), roles: [...new Set(roles)],
    adjustments, decidedBy: by, at: new Date().toISOString(),
    ...(input.override ? { overridden: { by, reason: input.override.reason, from: proposal.tier } } : {}),
  }
}
