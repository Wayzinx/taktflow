import type { RequirementSummary } from '@taktflow/core'
import { StatusDot } from '../components/ui'
import { Link } from '../lib/router'
import { NODE_STATUS } from '../lib/status'

/** 只有"运行中 / 等人"两种状态点会跳；其余按状态色静止显示。 */
const STATE_WORD: Partial<Record<NonNullable<RequirementSummary['current']>['status'], string>> = {
  running: '运行中',
  waiting_human: '等人',
  blocked: '阻塞',
  failed: '失败',
}

/**
 * 需求列表"当前节点"列（D 组）：状态点（运行中蓝 / 等人橙）+ 节点名；点击跳到运行页该节点。
 * 档位图标由 requirements-table 放在 ID 旁边；tier 这里只进 title。
 */
export function CurrentNodeCell({ current, tier, compact }: { current?: RequirementSummary['current']; tier?: RequirementSummary['tier']; compact?: boolean }) {
  if (!current) return compact ? null : <span className="faint">—</span>
  const meta = NODE_STATUS[current.status]
  const word = STATE_WORD[current.status] ?? meta.label
  return (
    <Link
      to={`/run/${current.runId}?node=${encodeURIComponent(current.nodeId)}`}
      className="current-cell"
      title={`${word} · ${current.title}（${current.nodeId}）${tier ? ` · 档位 ${tier}` : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <StatusDot tone={meta.tone} pulse={current.status === 'running'} />
      <span className="truncate">{current.title}</span>
      {!compact && current.status !== 'running' && <span className="current-cell-state">{word}</span>}
    </Link>
  )
}
