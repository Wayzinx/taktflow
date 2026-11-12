import { TriangleAlert } from 'lucide-react'
import type { Risk, SpaceSummary } from '@taktflow/core'
import { useAsync } from '../api'
import { askSteward } from '../lib/ui-store'
import { Link, useLocation } from '../lib/router'
import { groupRisks, type RiskGroups } from './overview-status'

export type RiskIndex = Map<string, Risk[]>

export interface SpaceRisks extends RiskGroups {
  /** 还没拿到结果：此时不能下"没有风险"的结论。 */
  loading: boolean
  /** 风险接口失败：同样不能说"没有风险"。 */
  failed: boolean
}

/**
 * 当前空间未处理的风险（GET /api/steward/risks?space=&state=open）：按需求分组，另给出与需求无关的空间级风险。
 * 管家接口是跨空间的，需求 ID 在各空间里会重复（都有 REQ-001），所以必须按空间过滤；
 * 不带 /s/:id 前缀时当前空间是列表第一个（与空间切换器一致）。
 */
export function useSpaceRisks(): SpaceRisks {
  const { spaceId } = useLocation()
  const q = useAsync(async (ds) => {
    const id = spaceId ?? (await ds.spaces().catch(() => [] as SpaceSummary[]))[0]?.id
    const risks = await ds.risks({ state: 'open', ...(id ? { space: id } : {}) })
    return id ? risks.filter((r) => r.spaceId === id) : risks
  }, [spaceId])
  return { ...groupRisks(q.data ?? []), loading: !q.data && !q.error, failed: !q.data && !!q.error }
}

/** 风险的依据：成绩单退化去评测成绩单（风险引擎给的链接是总览），其余用风险自带的证据链接。 */
export function riskHref(r: Risk): string {
  if (r.kind === 'regression') {
    const card = r.key.slice(r.key.indexOf('//') + 2)
    return `/eval?card=${encodeURIComponent(card)}`
  }
  return r.evidence[0]?.href ?? (r.requirementId ? `/req/${r.requirementId}` : '/')
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

/**
 * 风险列表（总览"等你决定"下方）：全部未处理风险，包括不挂需求的空间级风险；每条点开是它的依据。
 * 标题后面写挂在哪个需求上，空间级的写"与需求无关"。
 */
export function RiskList({ risks }: { risks: Risk[] }) {
  return (
    <div className="ov-risks">
      <div className="ov-sub-head">
        <TriangleAlert aria-hidden />
        {risks.length} 条风险
      </div>
      <ul className="ov-sub-list">
        {risks.map((r) => (
          <li key={r.key}>
            <Link to={riskHref(r)} className={`ov-sub-item risk-item${r.level === 'high' ? ' high' : ''}`} title={`${r.level === 'high' ? '高风险' : '中风险'}：${r.title}\n${r.detail}`}>
              <span className="truncate">{r.title}</span>
              <span className="mono faint">{r.requirementId ?? '与需求无关'}</span>
              <span className="ov-sub-note truncate">{r.detail}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
