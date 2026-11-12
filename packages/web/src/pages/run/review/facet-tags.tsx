import type { CSSProperties, ReactNode } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, Clock3, History, PenLine, ScanEye, ShieldAlert, X } from 'lucide-react'
import type { ReviewFacets } from '@taktflow/core'
import type { Tone } from '../../../lib/status'
import { COVERAGE, FRESHNESS, outcomeView, toneColor, toneSoft } from './review-meta'
import './facet-tags.css'

const OUTCOME_ICON = { approved: CircleCheck, no_findings: CircleCheck, changes_requested: PenLine, rejected: X, escalated: ShieldAlert } as const

/** 一枚小标签：颜色 + 图标 + 文字（The Never Color Alone Rule）。 */
export function Tag({ tone, icon, children, title, className }: { tone: Tone | 'neutral'; icon?: ReactNode; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`rv-tag${tone === 'neutral' ? ' neutral' : ''}${className ? ` ${className}` : ''}`} style={{ '--tone': toneColor(tone), '--tone-soft': toneSoft(tone) } as CSSProperties} title={title}>
      {icon}
      {children}
    </span>
  )
}

/**
 * 评审的三枚正交标签：结论 · 覆盖 · 新鲜度（docs/design/19 §4）。
 * 没有结论（还没评完一轮）时第一枚显示"未出结论"；no_findings 显示"无问题"，不显示"通过"；
 * 还有未关闭的阻断 / 重要问题时结论写明遗留数（outcomeView）。
 */
export function FacetTags({ facets, compact }: { facets?: ReviewFacets; compact?: boolean }) {
  if (!facets) return null
  const o = outcomeView(facets)
  const OIcon = !facets.outcome ? CircleDashed : o?.leftover ? CircleAlert : OUTCOME_ICON[facets.outcome]
  const c = COVERAGE[facets.coverage]
  const f = FRESHNESS[facets.freshness]
  return (
    <span className={`rv-facets${compact ? ' compact' : ''}`} aria-label="结论 · 覆盖 · 新鲜度">
      <Tag tone={o?.tone ?? 'neutral'} icon={<OIcon />} title={o ? `结论：${o.hint}` : '结论'}>
        {o?.label ?? '未出结论'}
      </Tag>
      <span className="rv-facet-sep" aria-hidden>·</span>
      <Tag tone={c.tone} icon={<ScanEye />} title={`覆盖：${c.hint}`}>
        {c.label}
      </Tag>
      <span className="rv-facet-sep" aria-hidden>·</span>
      <Tag tone={f.tone} icon={facets.freshness === 'stale' ? <History /> : <Clock3 />} title={`新鲜度：${f.hint}`}>
        {f.label}
      </Tag>
    </span>
  )
}

/** 未关闭问题：按人工处置过滤、groupKey 去重后的计数（只列非零档）。 */
export function OpenCounts({ open }: { open: ReviewFacets['open'] }) {
  const parts: Array<[string, number, Tone | 'neutral']> = [
    ['阻断', open.blocker, 'failed'],
    ['重要', open.major, 'waiting'],
    ['次要', open.minor, 'neutral'],
    ['措辞', open.nit, 'neutral'],
  ]
  const shown = parts.filter(([, n]) => n > 0)
  if (!shown.length) return <span className="faint">没有未关闭的问题</span>
  return (
    <span className="rv-open-counts">
      {shown.map(([label, n, tone]) => (
        <Tag key={label} tone={tone}>
          {label} <span className="num">{n}</span>
        </Tag>
      ))}
    </span>
  )
}
