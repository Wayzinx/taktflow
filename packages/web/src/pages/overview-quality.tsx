import { ShieldCheck } from 'lucide-react'
import type { ProjectOverview, QualityMetrics, RequirementSummary } from '@taktflow/core'
import { CountUp } from '../components/ui'
import type { Tile } from '../components/viz'

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

/**
 * 总览读数"已校验 / 拦截"：拦截按来源拆分取各需求的 quality 合计（totals 只有总数）；色段宽度是静态 flex 比例。
 */
export function qualityTile(totals: ProjectOverview['totals'], requirements: RequirementSummary[]): Tile {
  const by = sumBy(requirements)
  const parts = INTERCEPT_SOURCES.filter((s) => by[s.key] > 0)
  const total = parts.reduce((n, s) => n + by[s.key], 0)
  return {
    key: 'quality',
    label: '已校验 / 拦截',
    icon: <ShieldCheck />,
    value: <CountUp value={totals.verified ?? 0} from0 />,
    unit: (
      <>
        / <CountUp value={totals.intercepted ?? 0} from0 /> 拦截
      </>
    ),
    hint: parts.length ? parts.slice(0, 3).map((s) => `${s.label} ${by[s.key]}`).join(' · ') : '交付前被拦下的问题',
    children:
      total > 0 ? (
        <div className="share-bar" aria-label="拦截按来源拆分">
          {parts.map((s) => (
            <span key={s.key} title={`${s.label}（${s.hint}）· ${by[s.key]}`} style={{ flex: by[s.key] / total, background: s.color }} />
          ))}
        </div>
      ) : undefined,
  }
}
