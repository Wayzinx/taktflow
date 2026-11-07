import type { CSSProperties } from 'react'
import './primitives.css'

/**
 * 骨架屏（体验基线 2）：形状贴近真实布局；加载超过 120ms 才淡入（CSS 延迟，快速返回不闪）；扫光在 reduced-motion 下静止。
 * 禁止用"…""加载中"文字代替加载状态（ux:audit 会报）。
 *   {q.loading && !q.data ? <SkeletonRows rows={6} /> : <Table … />}
 */
export function Skeleton({ w = '100%', h = 12, r, style, className, immediate }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties; className?: string; /** 不等 120ms（已经在骨架容器里时） */ immediate?: boolean }) {
  return <span aria-hidden className={`sk${immediate ? '' : ' sk-delay'}${className ? ` ${className}` : ''}`} style={{ width: w, height: h, borderRadius: r, ...style }} />
}

/** 表格 / 列表行：图标 + 标题 + 右侧元信息。 */
export function SkeletonRows({ rows = 5, gap = 14, icon = true }: { rows?: number; gap?: number; icon?: boolean }) {
  return (
    <div className="sk-rows" style={{ gap }} role="status" aria-label="正在读取">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row">
          {icon && <Skeleton w={22} h={22} r={6} />}
          <Skeleton w={`${38 + ((i * 17) % 40)}%`} h={11} />
          <span style={{ flex: 1 }} />
          <Skeleton w={56} h={11} />
        </div>
      ))}
    </div>
  )
}

/** 段落：最后一行短一些。 */
export function SkeletonText({ lines = 3, width = '100%' }: { lines?: number; width?: number | string }) {
  return (
    <div className="sk-text" style={{ width }} role="status" aria-label="正在读取">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} h={10} w={i === lines - 1 ? '62%' : `${92 - ((i * 7) % 14)}%`} />
      ))}
    </div>
  )
}

/** 卡片：标题行 + 两行正文 + 底部指标。 */
export function SkeletonCard({ height }: { height?: number }) {
  return (
    <div className="sk-card" style={{ minHeight: height }} role="status" aria-label="正在读取">
      <div className="sk-row">
        <Skeleton w={28} h={28} r={8} />
        <Skeleton w="46%" h={12} />
      </div>
      <SkeletonText lines={2} />
      <div className="sk-row">
        <Skeleton w={64} h={18} r={9} />
        <Skeleton w={48} h={18} r={9} />
      </div>
    </div>
  )
}

/** 卡片网格（空间卡片、知识库卡片）。 */
export function SkeletonGrid({ count = 6, min = 260 }: { count?: number; min?: number }) {
  return (
    <div className="sk-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}
