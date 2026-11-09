import type { StewardPick, StewardPrefs } from '../api.js'
import { computeRisks } from '../insights/risks.js'
import { type StewardDeps, timestamp } from './contracts.js'
import { requirementSnapshot, requirementState } from './entity.js'
import { findLimit, requirementActivityAt } from './find.js'

const rank: Record<StewardPick['reason'], number> = { waiting: 0, failed: 1, risk: 2, changed: 3, running: 4 }
const why: Record<StewardPick['reason'], string> = { waiting: '有事情等你决定', failed: '运行失败，需要处理', risk: '存在高风险', changed: '24 小时内有变化', running: '正在推进' }
export async function stewardPicks(deps: StewardDeps, prefs: StewardPrefs, requestedLimit?: number): Promise<StewardPick[]> {
  const limit = findLimit(requestedLimit, 6), now = deps.now?.() ?? new Date()
  const candidates: Array<StewardPick & { updatedAt: string }> = []
  for (const summary of (await deps.spaces()).filter(space => !space.archived && !prefs.mutedSpaces?.includes(space.id))) {
    const space = await deps.open(summary.id)
    const risks = [...await computeRisks(space.stores, space.id, now), ...await deps.extraRisks?.(space) ?? []]
    for (const req of await space.stores.workspaces.listRequirements()) {
      const state = await requirementState(space, req.id)
      if (state.status === 'archived') continue
      const updatedAt = await requirementActivityAt(space, req.id, req.updatedAt)
      const changed = now.getTime() - Date.parse(updatedAt) <= 86400000
      // 已交付的资格以交付时间为准，后续编辑不能让旧交付重新占据首页。
      const deliveredAt = state.detail?.run.endedAt ?? req.updatedAt
      if (state.status === 'delivered' && now.getTime() - Date.parse(deliveredAt) > 86400000) continue
      const reason: StewardPick['reason'] | undefined = state.attention.length || state.detail?.graph.nodes.some(node => node.status === 'waiting_human') ? 'waiting'
        : state.status === 'blocked' ? 'failed'
          : risks.some(risk => risk.level === 'high' && risk.requirementId === req.id && (!('state' in risk) || risk.state === 'open')) ? 'risk'
            : changed ? 'changed' : state.status === 'active' ? 'running' : undefined
      if (!reason) continue
      const ref = { type: 'requirement' as const, spaceId: space.id, id: req.id }
      candidates.push({ ref, snapshot: requirementSnapshot(state, timestamp(deps)), reason, why: why[reason], updatedAt })
    }
  }
  candidates.sort((a, b) => rank[a.reason] - rank[b.reason] || b.updatedAt.localeCompare(a.updatedAt) || `${a.ref.spaceId}/${a.ref.id}`.localeCompare(`${b.ref.spaceId}/${b.ref.id}`))
  const counts = new Map<string, number>(), items: StewardPick[] = []
  // limit=1 时仍允许呈现一张卡；其他情况严格不超过一半，不拿低优先空间补满配额。
  const quota = Math.max(1, Math.floor(limit / 2))
  for (const { updatedAt: _, ...item } of candidates) {
    const id = item.ref.spaceId!, count = counts.get(id) ?? 0
    if (count >= quota) continue
    items.push(item); counts.set(id, count + 1)
    if (items.length === limit) break
  }
  return items
}
