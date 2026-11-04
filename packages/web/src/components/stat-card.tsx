import type { CSSProperties, ReactNode } from 'react'
import './stat-card.css'

/** 统计卡：顶部一条色调线 + 图标标签 + 大数字 + 脚注（总览、设置页共用）。 */
export function StatCard({ label, icon, value, foot, tone, children }: { label: string; icon: ReactNode; value: ReactNode; foot: ReactNode; tone?: string; children?: ReactNode }) {
  return (
    <div className="card stat-card" style={tone ? ({ '--stat-tone': tone } as CSSProperties) : undefined}>
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
