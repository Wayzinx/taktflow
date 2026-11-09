/**
 * Solo 的演示接口（docs/design/28）：find 与 picks 按演示空间里的需求现算，口径与服务端一致（编号 > 标题 > 最近；等你 > 失败 > 刚变化 > 在跑）。
 */
import type { RequirementSummary, StewardFindResult, StewardFindType, StewardPick } from '@taktflow/core'
import { requirementLook } from '../lib/entity-look'

export interface SoloSpace {
  id: string
  name: string
  requirements: RequirementSummary[]
}

/** 问句里的意图词与虚词：找标题时去掉。 */
const NOISE = /那个|这个|需求|现在|到哪了?|卡在哪(里)?|进度|状态|怎么样了?|运行图|流程图|画布|节点|看看|一下|帮我|的|了|吗|呢|？|\?/g
const reqNo = (s: string) => /(?:req)[\s-]*0*(\d{1,4})/i.exec(s)?.[1]

const bigrams = (s: string) => new Set([...s].slice(0, -1).map((c, i) => c + s[i + 1]))
function titleScore(title: string, q: string): number {
  if (!q) return 0
  if (title.includes(q)) return 0.9
  const a = bigrams(q), b = bigrams(title)
  if (!a.size) return 0
  const hit = [...a].filter((x) => b.has(x)).length
  return (hit / a.size) * 0.8
}

const at = (r: RequirementSummary) => r.updatedAt

export function mockFind(spaces: SoloSpace[], q: string, opts: { types?: StewardFindType[]; spaceId?: string; limit?: number } = {}): StewardFindResult {
  if (opts.types && !opts.types.includes('requirement')) return { items: [], ambiguous: false }
  const no = reqNo(q)
  const text = q.replace(/req[\s-]*\d+/gi, '').replace(NOISE, '').trim()
  const items = spaces
    .filter((s) => !opts.spaceId || s.id === opts.spaceId)
    .flatMap((s) =>
      s.requirements.map((r) => {
        const idNo = reqNo(r.id)
        const exact = no !== undefined && idNo !== undefined && Number(no) === Number(idNo)
        const t = titleScore(r.title, text)
        const score = exact ? 1 : t
        const match = exact ? ('id' as const) : t > 0 ? ('title' as const) : ('recent' as const)
        return { ref: { type: 'requirement' as const, spaceId: s.id, id: r.id, label: `${r.id} ${r.title}` }, snapshot: { ...requirementLook(r), at: at(r) }, why: exact ? '编号命中' : t > 0 ? `标题含「${text}」` : undefined, score, match }
      }),
    )
    .filter((x) => x.score > 0.25)
    .sort((a, b) => b.score - a.score || b.snapshot.at.localeCompare(a.snapshot.at))
    .slice(0, opts.limit ?? 8)
  const [a, b] = items
  return { items, ambiguous: !!a && !!b && a.score - b.score < a.score * 0.15 }
}

const RANK: Record<StewardPick['reason'], number> = { waiting: 0, failed: 1, risk: 2, changed: 3, running: 4 }

export function mockPicks(spaces: SoloSpace[], limit = 6): StewardPick[] {
  const day = Date.now() - 24 * 3600_000
  const all = spaces.flatMap((s) =>
    s.requirements
      .filter((r) => r.status !== 'archived' && (r.status !== 'delivered' || Date.parse(at(r)) > day))
      .map((r): StewardPick | undefined => {
        const look = requirementLook(r)
        const reason: StewardPick['reason'] | undefined =
          r.pendingAttention ? 'waiting' : look.tone === 'failed' ? 'failed' : Date.parse(at(r)) > day ? 'changed' : look.tone === 'running' ? 'running' : undefined
        if (!reason) return undefined
        const why = reason === 'waiting' ? look.summary : reason === 'failed' ? '最近一次运行失败' : reason === 'changed' ? '24 小时内有变化' : '正在跑'
        return { ref: { type: 'requirement', spaceId: s.id, id: r.id, label: `${r.id} ${r.title}` }, snapshot: { ...look, at: at(r) }, reason, why }
      })
      .filter((x): x is StewardPick => !!x),
  )
  return all.sort((a, b) => RANK[a.reason] - RANK[b.reason] || b.snapshot.at.localeCompare(a.snapshot.at)).slice(0, limit)
}
