import type { CSSProperties } from 'react'
import type { StageProgress } from '@taktflow/core'
import { STAGE_STATUS, toneSoftVar, toneVar } from '../lib/status'
import './stage-bar.css'

/** 阶段条。compact：传送带分段 + 当前阶段（图标 + 名称）（表格里用）；full：等分的分段轨道（详情页头部用）。 */
/** empty：没有阶段时的说明。真实数据里轻量流程（quick-fix、群聊临时任务）可能不划分阶段，不能一律说"尚未运行"。 */
/** full + onStage：每格是按钮（运行页点阶段 → 画布聚焦到该泳道），activeId 是当前聚焦的阶段。 */
export function StageBar({
  stages,
  variant = 'compact',
  showLabel = true,
  empty = '尚未运行',
  onStage,
  activeId,
}: {
  stages: StageProgress[]
  variant?: 'compact' | 'full'
  showLabel?: boolean
  empty?: string
  onStage?: (id: string) => void
  activeId?: string
}) {
  if (stages.length === 0) return <span className="stage-empty">{empty}</span>
  if (variant === 'full') {
    return (
      <div className="stage-track">
        {stages.map((s) => {
          const meta = STAGE_STATUS[s.status]
          const Icon = meta.icon
          const Tag = onStage ? 'button' : 'div'
          return (
            <Tag
              key={s.id}
              {...(onStage ? { type: 'button' as const, onClick: () => onStage(s.id), 'aria-pressed': activeId === s.id } : {})}
              className={`stage-cell st-${s.status}${onStage ? ' stage-click' : ''}${activeId === s.id ? ' on' : ''}`}
              style={{ '--tone': toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties}
              title={`${s.title} · ${meta.label}${onStage ? ' · 点击在画布上定位' : ''}`}
            >
              <span className="stage-cell-bar">
                <span style={{ '--p': s.total ? s.done / s.total : 0 } as CSSProperties} />
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
            </Tag>
          )
        })}
      </div>
    )
  }
  const current = stages.find((s) => s.status !== 'done' && s.status !== 'todo') ?? stages.find((s) => s.status === 'todo')
  const allDone = stages.every((s) => s.status === 'done')
  const doneCount = stages.filter((s) => s.status === 'done').length
  const curMeta = allDone ? STAGE_STATUS.done : current ? STAGE_STATUS[current.status] : STAGE_STATUS.todo
  const CurIcon = curMeta.icon
  const label = allDone ? '已完成' : current?.title
  return (
    <span className="stage-belt" style={{ '--tone': toneVar(curMeta.tone) } as CSSProperties}>
      <span className="stage-belt-row" role="img" aria-label={`${doneCount}/${stages.length} 个阶段完成${label ? `，当前：${label} · ${curMeta.label}` : ''}`}>
        {stages.map((s) => {
          const meta = STAGE_STATUS[s.status]
          return <span key={s.id} className={`belt-seg st-${s.status}`} style={{ '--seg': toneVar(meta.tone) } as CSSProperties} title={`${s.title} · ${meta.label} · ${s.done}/${s.total}`} />
        })}
      </span>
      {showLabel && label && (
        <span className={`stage-belt-label${current?.status === 'todo' && !allDone ? ' idle' : ''}`}>
          <CurIcon className={curMeta.spin ? 'spin' : undefined} strokeWidth={2.4} aria-hidden />
          <span className="truncate">{label}</span>
        </span>
      )}
    </span>
  )
}
