import type { NodeChanges } from '@taktflow/core'
import { useAsync } from '../../../api'
import { Dialog, ErrorState, Skeleton } from '../../../components/ui'
import { DiffView } from '../../workflow/collab/diff-view'
import { parseUnifiedDiff } from '../../workflow/collab/line-diff'
import { DeltaBar } from './changes-card'

/** 把多文件统一 diff 按 `--- a/<path>` 切开。 */
function splitPatch(patch: string): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = []
  for (const part of patch.split(/^(?=--- (?:a\/)?)/m)) {
    const m = /^--- (?:a\/)?(.+)\n\+\+\+ (?:b\/)?(.+)\n/.exec(part)
    if (m) out.push({ path: m[2] === '/dev/null' ? m[1]! : m[2]!, body: part })
    else if (part.trim()) out.push({ path: '', body: part })
  }
  return out
}

function DiffBody({ runId, nodeId, path, files }: { runId: string; nodeId: string; path?: string; files: NodeChanges['files'] }) {
  const q = useAsync((s) => s.nodeDiff(runId, nodeId, path), [runId, nodeId, path ?? ''])
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data) return <Skeleton h={220} />
  const parts = splitPatch(q.data.patch)
  if (!parts.length) return <p className="faint">没有可显示的 diff。</p>
  return (
    <div className="chg-diffs">
      {parts.map((p) => {
        const f = files.find((x) => x.path === p.path)
        return (
          <section key={p.path || 'patch'} className="chg-diff">
            {parts.length > 1 && (
              <header className="chg-diff-head">
                <span className="mono truncate">{p.path}</span>
                {f && <DeltaBar add={f.add} del={f.del} />}
              </header>
            )}
            <DiffView rows={parseUnifiedDiff(p.body)} label={`${p.path} 的改动`} />
          </section>
        )
      })}
    </div>
  )
}

export function DiffDialog({ open, onClose, runId, nodeId, path, files }: { open: boolean; onClose: () => void; runId: string; nodeId: string; path?: string; files: NodeChanges['files'] }) {
  const f = path ? files.find((x) => x.path === path) : undefined
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={path ? <span className="mono">{path}</span> : '本节点的全部改动'}
      description={f ? (f.scope === 'repo' ? `仓库 ${f.repo ?? ''}：相对节点开始前的提交` : `存放区：v${f.from ?? 0} → v${f.to}`) : `${files.length} 个文件，相对节点开始前的状态`}
    >
      {open && <DiffBody runId={runId} nodeId={nodeId} path={path} files={files} />}
    </Dialog>
  )
}
