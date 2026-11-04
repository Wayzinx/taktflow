import type { CSSProperties } from 'react'
import type { StageProgress } from '@taktflow/core'
import { STAGE_STATUS, toneSoftVar, toneVar } from '../lib/status'
import './stage-bar.css'

/** 阶段条。compact：一串胶囊 + 当前阶段名（表格里用）；full：等分的分段轨道（详情页头部用）。 */
export function StageBar({ stages, variant = 'compact', showLabel = true }: { stages: StageProgress[]; variant?: 'compact' | 'full'; showLabel?: boolean }) {
  if (stages.length === 0) return <span className="stage-empty">尚未运行</span>
  if (variant === 'full') {
    return (
      <div className="stage-track">
        {stages.map((s) => {
          const meta = STAGE_STATUS[s.status]
          const Icon = meta.icon
          return (
            <div key={s.id} className={`stage-cell st-${s.status}`} style={{ '--tone': toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties} title={`${s.title} · ${meta.label}`}>
              <span className="stage-cell-bar">
                <span style={{ width: s.total ? `${(s.done / s.total) * 100}%` : 0 }} />
              </span>
              <span className="stage-cell-body">
                <span className="stage-cell-icon">
                  <Icon className={meta.spin ? 'spin' : undefined} strokeWidth={2.6} />
                </span>
                <span className="stage-cell-title truncate">{s.title}</span>
                <span className="stage-cell-count num">
                  {s.done}/{s.total}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    )
  }
  const current = stages.find((s) => s.status !== 'done' && s.status !== 'todo') ?? stages.find((s) => s.status === 'todo')
  const allDone = stages.every((s) => s.status === 'done')
  const label = allDone ? '已完成' : current?.title
  const labelTone = allDone ? 'success' : current ? STAGE_STATUS[current.status].tone : 'pending'
  return (
    <span className="stage-pills">
      <span className="stage-pills-row">
        {stages.map((s) => {
          const meta = STAGE_STATUS[s.status]
          const Icon = meta.icon
          return (
            <span key={s.id} className={`stage-pill st-${s.status}`} style={{ '--tone': toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties} title={`${s.title} · ${meta.label} · ${s.done}/${s.total}`}>
              <Icon className={meta.spin ? 'spin' : undefined} strokeWidth={2.8} />
            </span>
          )
        })}
      </span>
      {showLabel && label && (
        <span className="stage-pills-label truncate" style={{ color: labelTone === 'pending' ? 'var(--text-3)' : undefined }}>
          {label}
        </span>
      )}
    </span>
  )
}
