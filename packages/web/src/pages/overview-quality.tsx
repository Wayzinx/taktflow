import { ShieldCheck } from 'lucide-react'
import type { ProjectOverview, QualityMetrics, RequirementSummary } from '@taktflow/core'
import { StatCard } from '../components/stat-card'

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
 * 总览 KPI"已校验 / 已拦截"（D 组）：总览读数条（StatStrip）里的一格。
 * 拦截按来源拆分取各需求的 quality 合计（totals 只有总数）；色段宽度是静态的 flex 比例，不做动画。
 */
export function QualityStat({ totals, requirements }: { totals: ProjectOverview['totals']; requirements?: RequirementSummary[] }) {
  const verified = totals.verified ?? 0
  const intercepted = totals.intercepted ?? 0
  const by = requirements ? sumBy(requirements) : undefined
  const parts = by ? INTERCEPT_SOURCES.filter((s) => by[s.key] > 0) : []
  const total = parts.reduce((n, s) => n + by![s.key], 0)
  return (
    <StatCard
      label="已校验 / 已拦截"
      icon={<ShieldCheck />}
      value={
        <>
          {verified}
          <span className="stat-unit">
            / <b className="stat-unit-strong">{intercepted}</b> 拦截
          </span>
        </>
      }
      foot={
        parts.length ? (
          <span className="quality-legend">
            {parts.slice(0, 3).map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} aria-hidden />
                {s.label} <b>{by![s.key]}</b>
              </span>
            ))}
            {parts.length > 3 && <span>等 {parts.length} 类</span>}
          </span>
        ) : (
          <>交付前被拦下的问题</>
        )
      }
    >
      {total > 0 && (
        <div className="token-share quality-share" aria-label="拦截按来源拆分">
          {parts.map((s) => (
            <span key={s.key} title={`${s.label}（${s.hint}）· ${by![s.key]}`} style={{ flex: by![s.key] / total, background: s.color }} />
          ))}
        </div>
      )}
    </StatCard>
  )
}
