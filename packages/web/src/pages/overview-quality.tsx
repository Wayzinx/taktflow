import { ShieldCheck } from 'lucide-react'
import type { ProjectOverview, QualityMetrics, RequirementSummary } from '@taktflow/core'
import { CountUp } from '../components/ui'
import type { Tile } from '../components/viz'
import { navigate } from '../lib/router'

type Source = keyof QualityMetrics['interceptedBy']

/** 拦截来源（docs/design/19 §6）：顺序与颜色总览、度量 Tab 共用。 */
export const INTERCEPT_SOURCES: Array<{ key: Source; label: string; hint: string; color: string }> = [
  { key: 'gate', label: '门禁', hint: '未通过的门禁检查', color: 'var(--c-1)' },
  { key: 'review', label: '评审', hint: '评审轮里的 blocker / major', color: 'var(--c-6)' },
  { key: 'judge', label: '判决', hint: '判为 product_bug 的失败', color: 'var(--c-5)' },
  { key: 'completion', label: '完成标准', hint: '自检未满足', color: 'var(--c-3)' },
  { key: 'fingerprint', label: '失败指纹', hint: '被抑制的重复重试', color: 'var(--c-4)' },
]

function sumBy(reqs: RequirementSummary[]): Record<Source, number> {
  const by = { gate: 0, review: 0, judge: 0, completion: 0, fingerprint: 0 }
  for (const r of reqs) for (const s of INTERCEPT_SOURCES) by[s.key] += r.quality?.interceptedBy[s.key] ?? 0
  return by
}

/** 拆分说明：按数量从多到少列两项，剩下的并成"其他"，加起来等于总数。 */
function breakdown(items: Array<[string, number]>): string {
  const sorted = [...items].sort((x, y) => y[1] - x[1])
  const shown = sorted.length > 3 ? sorted.slice(0, 2) : sorted
  const rest = sorted.slice(shown.length).reduce((n, [, v]) => n + v, 0)
  return [...shown.map(([label, n]) => `${label} ${n}`), ...(rest ? [`其他 ${rest}`] : [])].join(' · ')
}

/**
 * 总览读数"校验 · 拦截"：两个数单位不同（校验按检查项 / 评审轮计，拦截按问题条数计），分开写明单位，不写成分数。
 * 拦截按来源拆分取各需求的 quality 合计（totals 只有总数）；色段宽度是静态 flex 比例。点开是按拦截数排序的需求列表。
 */
export function qualityTile(totals: ProjectOverview['totals'], requirements: RequirementSummary[]): Tile {
  const by = sumBy(requirements)
  const parts = INTERCEPT_SOURCES.filter((s) => by[s.key] > 0)
  const total = parts.reduce((n, s) => n + by[s.key], 0)
  const verified = totals.verified ?? 0
  const intercepted = totals.intercepted ?? 0
  return {
    key: 'quality',
    label: '校验 · 拦截',
    icon: <ShieldCheck />,
    value: <CountUp value={verified} from0 />,
    unit: '项已校验',
    hint: (
      <>
        拦下 <b>{intercepted}</b> 个问题{parts.length ? ` · ${breakdown(parts.map((s) => [s.label, by[s.key]]))}` : ''}
      </>
    ),
    children:
      total > 0 ? (
        <div className="share-bar" aria-label="拦截按来源拆分">
          {parts.map((s) => (
            <span key={s.key} title={`${s.label}（${s.hint}）· ${by[s.key]}`} style={{ flex: by[s.key] / total, background: s.color }} />
          ))}
        </div>
      ) : undefined,
    onClick: () => navigate('/requirements?sort=intercepted'),
    title: `已校验 ${verified} 项：通过的门禁检查项 + 通过的评审轮。\n拦下 ${intercepted} 个问题：未通过的门禁检查项、未通过评审轮里的 blocker / major 意见、判为代码缺陷的失败、未满足的完成标准、被抑制的重复重试。\n两个数单位不同，不是比例。点开按拦截数看各需求。`,
  }
}
