import type { AttentionItem, RequirementSummary, SpaceMember } from '@taktflow/core'

/**
 * 待办派给谁：assignees 优先；没有 assignees 时，节点职责（owner）在谁的 duties 里就派给谁；
 * 没有任何成员承担这项职责（或节点没写职责）时回退给需求负责人，免得负责人按"派给我"筛选漏掉自己需求上唯一的阻塞项。
 */
export function assigneesOf(a: AttentionItem, members: SpaceMember[], reqs: RequirementSummary[]): { ids: string[]; fallback: boolean } {
  if (a.assignees?.length) return { ids: a.assignees, fallback: false }
  const byDuty = a.owner ? members.filter((m) => m.duties?.includes(a.owner!)).map((m) => m.id) : []
  if (byDuty.length) return { ids: byDuty, fallback: false }
  const owner = reqs.find((r) => r.id === a.requirementId)?.owner
  return { ids: owner ? [owner] : [], fallback: !!owner }
}

export const assignedTo = (a: AttentionItem, me: SpaceMember | undefined, members: SpaceMember[], reqs: RequirementSummary[]) =>
  !!me && assigneesOf(a, members, reqs).ids.includes(me.id)

/** 卡片文案用：职责没有任何成员承担、已兜底转给需求负责人时，给出职责和负责人名字。 */
export function fallbackAssigneeOf(a: AttentionItem, members: SpaceMember[], reqs: RequirementSummary[]): { duty: string; ownerId: string; ownerName: string } | undefined {
  if (!a.owner || a.assignees?.length) return undefined
  if (members.some((m) => m.duties?.includes(a.owner!))) return undefined
  const ownerId = reqs.find((r) => r.id === a.requirementId)?.owner
  if (!ownerId) return undefined
  return { duty: a.owner, ownerId, ownerName: members.find((m) => m.id === ownerId)?.name ?? ownerId }
}

/** 节点职责里没有任何成员承担的（按职责去重、排序）；成员页据此提示补人。 */
export function uncoveredDuties(members: SpaceMember[], items: AttentionItem[]): string[] {
  const duties = new Set<string>()
  for (const a of items) if (a.owner && !members.some((m) => m.duties?.includes(a.owner!))) duties.add(a.owner)
  return [...duties].sort()
}
