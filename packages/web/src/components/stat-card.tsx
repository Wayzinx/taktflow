import type { CSSProperties, ReactNode } from 'react'
import './stat-card.css'

/**
 * 读数条：一块面板里并排几格读数，格间用细分隔线，像仪表盘上的一排表头。
 * 不做四张一样的卡片：读数是同一组信息，放在同一个面里。
 */
export function StatStrip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="stat-strip" aria-label={label}>
      {children}
    </section>
  )
}

/**
 * 一格读数。tone 只在数字表达状态时给（阻塞、不可用、缺密钥），
 * 此时图标和数字一起着色；中性读数保持墨色。
 */
export function StatCard({ label, icon, value, foot, tone, children }: { label: string; icon: ReactNode; value: ReactNode; foot: ReactNode; tone?: string; children?: ReactNode }) {
  return (
    <div className={`stat-cell${tone ? ' toned' : ''}`} style={tone ? ({ '--stat-tone': tone } as CSSProperties) : undefined}>
      <div className="stat-label">
        <span className="stat-icon">{icon}</span>
        {label}
      </div>
      <div className="stat-value num">{value}</div>
      {children}
      <div className="stat-foot">{foot}</div>
    </div>
  )
}
