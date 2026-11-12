import type { RequirementSummary } from '@taktflow/core'
import { costOf, totalTokens } from '../lib/format'

/** 需求列表的筛选与排序，全部写进 URL（?status=&mine=1&q=&sort=&order=），分享出去看到的是同一份。 */
export type ReqFilter = 'all' | 'active' | 'blocked' | 'delivered' | 'draft' | 'risk'
export type ReqSort = 'id' | 'stage' | 'tokens' | 'cost' | 'intercepted' | 'updated'
export type SortOrder = 'asc' | 'desc'

export interface ReqView {
  filter: ReqFilter
  mine: boolean
  text: string
  sort?: ReqSort
  order: SortOrder
}

const FILTERS: ReqFilter[] = ['all', 'active', 'blocked', 'delivered', 'draft', 'risk']
const SORTS: ReqSort[] = ['id', 'stage', 'tokens', 'cost', 'intercepted', 'updated']
/** 第一次点表头时的方向：数量和时间先看大的 / 新的，ID 和阶段从前往后。 */
export const FIRST_ORDER: Record<ReqSort, SortOrder> = { id: 'asc', stage: 'asc', tokens: 'desc', cost: 'desc', intercepted: 'desc', updated: 'desc' }

export function readView(query: URLSearchParams): ReqView {
  const filter = query.get('status') as ReqFilter
  const sort = query.get('sort') as ReqSort
  const known = SORTS.includes(sort) ? sort : undefined
  return {
    filter: FILTERS.includes(filter) ? filter : 'all',
    mine: query.get('mine') === '1',
    text: query.get('q') ?? '',
    sort: known,
    order: query.get('order') === 'asc' || query.get('order') === 'desc' ? (query.get('order') as SortOrder) : known ? FIRST_ORDER[known] : 'asc',
  }
}

/** 点表头：换列时用该列的默认方向，同一列再点就反过来。返回给 setQuery 的补丁（默认值不写进 URL）。 */
export function sortPatch(view: ReqView, key: ReqSort): Record<string, string | undefined> {
  const order = view.sort === key ? (view.order === 'asc' ? 'desc' : 'asc') : FIRST_ORDER[key]
  return { sort: key, order: order === FIRST_ORDER[key] ? undefined : order }
}

export const matchText = (r: RequirementSummary, text: string) => {
  const t = text.trim().toLowerCase()
  return !t || r.id.toLowerCase().includes(t) || r.title.toLowerCase().includes(t)
}

/** 阶段进度：已完成阶段的占比；已交付算走完，没跑过算 0。 */
const progress = (r: RequirementSummary) => (r.status === 'delivered' ? 1 : r.stages.length ? r.stages.filter((s) => s.status === 'done').length / r.stages.length : 0)

const VALUE: Record<ReqSort, (r: RequirementSummary) => number | string> = {
  id: (r) => r.id,
  stage: progress,
  tokens: (r) => totalTokens(r.usage),
  cost: (r) => costOf(r.usage).usd ?? 0,
  intercepted: (r) => r.quality?.intercepted ?? 0,
  updated: (r) => Date.parse(r.updatedAt) || 0,
}

export function sortRequirements(rows: RequirementSummary[], sort: ReqSort | undefined, order: SortOrder): RequirementSummary[] {
  if (!sort) return rows
  const value = VALUE[sort]
  const sign = order === 'asc' ? 1 : -1
  // 成本未上报的不管升序降序都排在最后，不当成 $0
  const unknownLast = (r: RequirementSummary) => sort === 'cost' && costOf(r.usage).usd === undefined
  return [...rows].sort((a, b) => {
    if (unknownLast(a) !== unknownLast(b)) return unknownLast(a) ? 1 : -1
    const x = value(a), y = value(b)
    const diff = typeof x === 'string' ? x.localeCompare(String(y), undefined, { numeric: true }) : x - (y as number)
    return diff * sign || a.id.localeCompare(b.id, undefined, { numeric: true })
  })
}
