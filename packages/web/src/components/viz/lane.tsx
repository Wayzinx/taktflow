import type { CSSProperties } from 'react'
import type { StageProgress, StewardStageStatus } from '@taktflow/core'

export type LaneStatus = StewardStageStatus
export interface LaneCell {
  key: string
  label: string
  status: LaneStatus
  /** 悬停说明里的补充（例如 3/4）。 */
  detail?: string
}

export const LANE_LABEL: Record<LaneStatus, string> = { done: '完成', running: '进行中', waiting: '等人', failed: '失败', todo: '未开始', skipped: '跳过' }

/** 运行数据里的阶段 → 泳道格。 */
export function cellsOf(stages: StageProgress[]): LaneCell[] {
  return stages.map((s) => ({ key: s.id, label: s.title, status: s.status === 'waiting_human' ? 'waiting' : s.status, detail: s.total ? `${s.done}/${s.total}` : undefined }))
}

/** 当前格：第一个没完成的非"未开始"格，否则第一个未开始的；全部完成返回 undefined。 */
export function currentCell(cells: LaneCell[]): LaneCell | undefined {
  return cells.find((c) => c.status !== 'done' && c.status !== 'todo' && c.status !== 'skipped') ?? cells.find((c) => c.status === 'todo')
}

/**
 * 泳道：一格一个检查点（阶段），状态只来自运行事件。
 * 首次出现时格子从左到右依次点亮（每格 18ms）；运行中的格子跟 --takt 节拍；等人用斜纹，失败实心，未开始空心。
 */
export function LaneTrack({ cells, size = 'md', animate = true, className }: { cells: LaneCell[]; size?: 'sm' | 'md'; animate?: boolean; className?: string }) {
  const done = cells.filter((c) => c.status === 'done').length
  const cur = currentCell(cells)
  return (
    <span
      className={`lane-track${className ? ` ${className}` : ''}`}
      data-size={size}
      data-animate={animate || undefined}
      role="img"
      aria-label={`${done}/${cells.length} 完成${cur ? `，当前：${cur.label} · ${LANE_LABEL[cur.status]}` : ''}`}
    >
      {cells.map((c, i) => (
        <span key={c.key} className="lane-cell" data-st={c.status} data-cur={c === cur || undefined} style={{ '--i': i } as CSSProperties} title={`${c.label} · ${LANE_LABEL[c.status]}${c.detail ? ` · ${c.detail}` : ''}`} />
      ))}
    </span>
  )
}
