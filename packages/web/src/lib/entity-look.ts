import type { NodeStatus, RequirementSummary, StageProgress, StageStatus, StewardEntitySnapshot, StewardStageStatus, StewardTone } from '@taktflow/core'

const STAGE: Record<StageStatus, StewardStageStatus> = { todo: 'todo', running: 'running', done: 'done', failed: 'failed', waiting_human: 'waiting' }
const NODE_WORD: Partial<Record<NodeStatus, string>> = { running: '在跑', waiting_human: '等人', failed: '失败', blocked: '阻塞', stale: '已过期' }
const NODE_TONE: Partial<Record<NodeStatus, StewardTone>> = { running: 'running', waiting_human: 'waiting', failed: 'failed', blocked: 'failed', stale: 'stale' }

export const stageCells = (stages: StageProgress[]) => stages.map((s) => ({ label: s.title, status: STAGE[s.status] }))

/**
 * 需求的人话状态，与服务端快照同一口径（docs/dev/m7-backend.md §1）：
 * 等你决定 > 当前节点 > 阶段失败 / 阻塞 > 进行中；已交付、已归档、还没开始各一句。
 */
export function requirementLook(r: RequirementSummary): Omit<StewardEntitySnapshot, 'at'> {
  const stages = stageCells(r.stages)
  const stage = r.stages.find((s) => s.status !== 'done')
  const where = stage ? `${stage.title} · ` : ''
  const waiting = r.pendingAttention
  const base = { title: r.title, stages, summary: waiting ? `${waiting} 件等你决定` : undefined }
  if (r.status === 'delivered') return { ...base, status: '已交付', tone: 'success' }
  if (r.status === 'archived') return { ...base, status: '已归档', tone: 'neutral' }
  if (!r.latestRunId) return { ...base, status: '还没开始', tone: 'neutral' }
  if (waiting) return { ...base, status: `${where}等你决定`, tone: 'waiting' }
  if (r.current && NODE_WORD[r.current.status]) return { ...base, status: `${where}${r.current.title}${NODE_WORD[r.current.status]}`, tone: NODE_TONE[r.current.status] ?? 'running' }
  if (stage?.status === 'failed' || r.status === 'blocked') return { ...base, status: `${where}失败`, tone: 'failed' }
  return { ...base, status: stage ? `${stage.title} · 进行中` : '进行中', tone: 'running' }
}
