import type { Tier } from '@taktflow/core'

/** 档位说明（docs/design/19 §1）：只看改动形状。 */
export const TIER_LABEL: Record<Tier, { title: string; hint: string }> = {
  T0: { title: 'T0 · 已写死', hint: '改动已经给定（diff / 命令），没有设计' },
  T1: { title: 'T1 · 单一改动面', hint: '恰好一个模块 / 目录 / 仓库' },
  T2: { title: 'T2 · 多面串行', hint: '多个改动面，有共享状态或先后依赖' },
  T3: { title: 'T3 · 多面并行', hint: '多个改动面，路径两两不相交' },
}

/**
 * 档位图标：用线条画"改动形状"。T0 直线；T1 线上一个节点；T2 三节点串联；T3 分叉再汇合。
 * 颜色继承 currentColor；size 为边长（px）。label 为 false 时作为装饰（aria-hidden）。
 */
export function TierGlyph({ tier, size = 16, label = true, className }: { tier: Tier; size?: number; label?: boolean; className?: string }) {
  const a11y = label ? { role: 'img' as const, 'aria-label': `档位 ${TIER_LABEL[tier].title}` } : { 'aria-hidden': true as const }
  return (
    <svg className={className ? `tier-glyph ${className}` : 'tier-glyph'} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...a11y}>
      {label && <title>{`${TIER_LABEL[tier].title}：${TIER_LABEL[tier].hint}`}</title>}
      {tier === 'T0' && <path d="M3 12h18" />}
      {tier === 'T1' && (
        <>
          <path d="M3 12h6.5M14.5 12H21" />
          <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
        </>
      )}
      {tier === 'T2' && (
        <>
          <path d="M7.2 12h2.6M14.2 12h2.6" />
          <circle cx="5" cy="12" r="2.2" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="2.2" fill="currentColor" stroke="none" />
        </>
      )}
      {tier === 'T3' && (
        <>
          <path d="M5.6 10.9 10.4 7.1M13.6 7.1l4.8 3.8M5.6 13.1l4.8 3.8M13.6 16.9l4.8-3.8" />
          <circle cx="4" cy="12" r="2" fill="currentColor" stroke="none" />
          <circle cx="12" cy="6" r="2" fill="currentColor" stroke="none" />
          <circle cx="12" cy="18" r="2" fill="currentColor" stroke="none" />
          <circle cx="20" cy="12" r="2" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}
