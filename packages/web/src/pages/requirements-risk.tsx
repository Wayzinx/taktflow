import { TriangleAlert } from 'lucide-react'
import type { Risk, SpaceSummary } from '@taktflow/core'
import { useAsync } from '../api'
import { askSteward } from '../lib/ui-store'
import { useLocation } from '../lib/router'

export type RiskIndex = Map<string, Risk[]>

/**
 * 当前空间未处理的风险，按需求分组（GET /api/steward/risks?space=&state=open）。拿不到时为空，不影响列表。
 * 管家接口是跨空间的，需求 ID 在各空间里会重复（都有 REQ-001），所以必须按空间过滤；
 * 不带 /s/:id 前缀时当前空间是列表第一个（与空间切换器一致）。
 */
export function useRequirementRisks(): RiskIndex {
  const { spaceId } = useLocation()
  const q = useAsync(async (ds) => {
    const id = spaceId ?? (await ds.spaces().catch(() => [] as SpaceSummary[]))[0]?.id
    const risks = await ds.risks({ state: 'open', ...(id ? { space: id } : {}) }).catch(() => [] as Risk[])
    return id ? risks.filter((r) => r.spaceId === id) : risks
  }, [spaceId])
  const map: RiskIndex = new Map()
  for (const r of q.data ?? []) {
    if (!r.requirementId) continue
    const list = map.get(r.requirementId) ?? []
    list.push(r)
    map.set(r.requirementId, list)
  }
  for (const list of map.values()) list.sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1))
  return map
}

/**
 * 需求行上的风险标记（D 组）：高风险红、中风险橙；悬停看原因，点击把这条风险交给管家。
 * 标记只占一个图标位，没有风险时不渲染，避免整列都是"—"。
 */
export function RiskMark({ risks, reqId }: { risks?: Risk[]; reqId: string }) {
  if (!risks?.length) return null
  const top = risks[0]!
  const high = top.level === 'high'
  const more = risks.length > 1 ? `（另有 ${risks.length - 1} 条）` : ''
  return (
    <button
      type="button"
      className={`risk-mark pressable${high ? ' high' : ''}`}
      title={`${high ? '高风险' : '中风险'}：${top.title}${more}\n${top.detail}\n点击让管家处理`}
      aria-label={`${high ? '高风险' : '中风险'}：${top.title}`}
      onClick={(e) => {
        e.stopPropagation()
        askSteward(`${reqId} 有风险：${top.title}。帮我看看怎么处理`, [{ type: 'requirement', id: reqId, label: reqId }])
      }}
    >
      <TriangleAlert aria-hidden />
      {risks.length > 1 && <span className="num">{risks.length}</span>}
    </button>
  )
}
