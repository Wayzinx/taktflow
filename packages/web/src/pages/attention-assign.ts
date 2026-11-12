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
