import { FileText, Workflow } from 'lucide-react'
import type { ArtifactRef, RoomMessage } from '@taktflow/core'
import { Link } from '../../../lib/router'

/** 产物引用：点开跳到需求页的产物 Tab 并选中该文件（带版本时定位到版本）。 */
export function ArtifactChip({ a }: { a: ArtifactRef }) {
  const q = new URLSearchParams({ tab: 'artifacts', path: a.path })
  if (a.version) q.set('v', String(a.version))
  return (
    <Link className="chip chat-ref" to={`/req/${a.workspace}?${q.toString()}`} title={`打开产物 ${a.path}`}>
      <FileText aria-hidden="true" />
      <span className="mono truncate">{a.path}</span>
      {a.version ? <span className="mono faint">v{a.version}</span> : null}
    </Link>
  )
}

/** 消息下方的引用条：产物、运行 / 节点。任务卡片自己展示运行，这里不重复。 */
export function MessageRefs({ m }: { m: RoomMessage }) {
  const r = m.refs
  if (!r) return null
  const runId = m.kind === 'task' || m.kind === 'attention' ? undefined : (r.runId ?? r.taskRunId)
  const arts = r.artifacts ?? []
  if (!arts.length && !runId) return null
  const nodeQ = r.nodeId ? `?node=${encodeURIComponent(r.nodeId)}` : ''
  return (
    <div className="chat-refs">
      {arts.map((a) => (
        <ArtifactChip key={`${a.path}@${a.version ?? ''}`} a={a} />
      ))}
      {runId && (
        <Link className="chip chat-ref" to={`/run/${runId}${nodeQ}`} title="打开运行">
          <Workflow aria-hidden="true" />
          <span className="mono truncate">{r.nodeId ? `${runId} · ${r.nodeId}` : runId}</span>
        </Link>
      )}
    </div>
  )
}
