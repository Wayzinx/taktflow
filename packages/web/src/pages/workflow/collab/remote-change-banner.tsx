import { useMemo } from 'react'
import { Bot, FileDiff, UserRound, X } from 'lucide-react'
import type { Actor } from '@taktflow/core'
import { actorName, fmtRelative } from '../../../lib/format'
import type { WorkflowDocState } from '../state'
import { diffNodes } from './changed-nodes'
import './collab.css'

const MAX_CHIPS = 6

function who(a: Actor): string {
  if (a.type === 'agent') return a.role === 'lead' ? 'Lead' : `Agent ${a.role}`
  return actorName(a)
}

/** 远端变更提示："Lead / Agent 刚修改了 workflow"，列出变化的节点，可一键看 diff（onShowDiff 打开修订抽屉）。wf.remoteChange 为空时不渲染。 */
export function RemoteChangeBanner({ wf, onShowDiff }: { wf: WorkflowDocState; onShowDiff: (rev: string) => void }) {
  const rc = wf.remoteChange
  const changes = useMemo(() => diffNodes(rc?.before, rc?.after), [rc])
  if (!rc) return null
  const r = rc.event.revision
  const Icon = r.author.type === 'agent' ? Bot : UserRound
  const chips = [
    ...changes.added.map((id) => ({ id, kind: 'add' as const, label: '新增' })),
    ...changes.modified.map((id) => ({ id, kind: 'mod' as const, label: '修改' })),
    ...changes.removed.map((id) => ({ id, kind: 'del' as const, label: '删除' })),
  ]
  return (
    <div className="wfc-remote" role="status" aria-live="polite">
      <span className="wfc-remote-icon">
        <Icon />
      </span>
      <div className="wfc-remote-main">
        <div className="wfc-remote-title">
          {who(r.author)} 刚修改了 workflow
          <span className="wfc-muted"> · {fmtRelative(r.at)} · </span>
          <span className="mono wfc-muted">{r.rev.slice(0, 8)}</span>
        </div>
        {(r.reason || r.summary) && <div className="wfc-remote-reason">{r.reason ?? r.summary}</div>}
        {chips.length > 0 && (
          <ul className="wfc-remote-nodes" aria-label="变化的节点（画布上已高亮）">
            {chips.slice(0, MAX_CHIPS).map((c) => (
              <li key={c.id} className={`wfc-node-chip is-${c.kind}`}>
                <span className="wfc-node-chip-kind">{c.label}</span>
                <span className="mono">{c.id}</span>
              </li>
            ))}
            {chips.length > MAX_CHIPS && <li className="wfc-muted">等 {chips.length} 个节点</li>}
          </ul>
        )}
        {!rc.after && <div className="wfc-remote-reason">处理完冲突后会载入这条修订。</div>}
      </div>
      <div className="wfc-remote-actions">
        <button className="btn btn-sm" onClick={() => onShowDiff(r.rev)}>
          <FileDiff />
          查看差异
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={wf.dismissRemoteChange} aria-label="知道了，取消高亮" title="知道了（取消高亮）">
          <X />
        </button>
      </div>
    </div>
  )
}
