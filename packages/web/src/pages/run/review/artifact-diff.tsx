import { useMemo, useState } from 'react'
import { ChevronRight, GitCompareArrows } from 'lucide-react'
import type { ArtifactRef } from '@taktflow/core'
import { useAsync } from '../../../api'
import { Skeleton } from '../../../components/ui'
import { Link } from '../../../lib/router'
import { diffStat, hunks, lineDiff } from './line-diff'

export interface VersionPair {
  path: string
  workspace: string
  from: number
  to: number
}

/** 两轮之间评审者看到的产物版本对：同一路径版本变了才算。 */
export function changedPairs(before: ArtifactRef[], after: ArtifactRef[]): VersionPair[] {
  return after.flatMap((b) => {
    const a = before.find((x) => x.path === b.path && x.workspace === b.workspace)
    return a?.version !== undefined && b.version !== undefined && a.version !== b.version ? [{ path: b.path, workspace: b.workspace, from: a.version, to: b.version }] : []
  })
}

export function ArtifactDiffs({ pairs }: { pairs: VersionPair[] }) {
  if (!pairs.length) return <p className="rv-empty">评审对象与上一轮相同，没有新版本。</p>
  return (
    <div className="rv-diffs">
      {pairs.map((p, i) => (
        <ArtifactDiff key={`${p.path}@${p.from}-${p.to}`} pair={p} defaultOpen={i === 0} />
      ))}
    </div>
  )
}

function ArtifactDiff({ pair, defaultOpen }: { pair: VersionPair; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const q = useAsync((ds) => Promise.all([ds.artifact(pair.workspace, pair.path, pair.from), ds.artifact(pair.workspace, pair.path, pair.to)]), [pair.workspace, pair.path, pair.from, pair.to])
  const lines = useMemo(() => (q.data ? lineDiff(q.data[0].content, q.data[1].content) : undefined), [q.data])
  const stat = lines && diffStat(lines)
  return (
    <div className="rv-diff">
      <button type="button" className="rv-diff-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={`rv-caret${open ? ' open' : ''}`} />
        <GitCompareArrows />
        <span className="mono truncate">{pair.path}</span>
        <span className="mono faint">
          v{pair.from} → v{pair.to}
        </span>
        <span style={{ flex: 1 }} />
        {stat && (
          <span className="rv-diff-stat mono num">
            <span className="add">+{stat.add}</span> <span className="del">−{stat.del}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="rv-diff-body">
          {q.error ? (
            <p className="rv-empty">读取产物版本失败：{q.error.message}</p>
          ) : !lines ? (
            <div style={{ display: 'grid', gap: 6, padding: 12 }}>
              <Skeleton w="70%" h={11} />
              <Skeleton w="50%" h={11} />
            </div>
          ) : q.data?.some((c) => c.encoding === 'base64') ? (
            <p className="rv-empty">二进制产物，不做行级对比。</p>
          ) : (
            <DiffView lines={lines} />
          )}
          <div className="rv-diff-foot">
            <Link to={`/req/${pair.workspace}?tab=artifacts&path=${encodeURIComponent(pair.path)}&v=${pair.to}`} className="rv-link">
              在产物页打开 v{pair.to}
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

function DiffView({ lines }: { lines: ReturnType<typeof lineDiff> }) {
  const hs = hunks(lines)
  if (!hs.length) return <p className="rv-empty">两个版本内容相同。</p>
  return (
    <div className="rv-diff-code mono" role="table" aria-label="行级差异">
      {hs.map((h, i) => (
        <div key={i} role="rowgroup">
          {h.skipped > 0 && <div className="rv-diff-skip">… {h.skipped} 行未改动</div>}
          {h.lines.map((l, j) => (
            <div key={j} className={`rv-dl ${l.kind}`} role="row">
              <span className="rv-dl-n num">{l.a ?? ''}</span>
              <span className="rv-dl-n num">{l.b ?? ''}</span>
              <span className="rv-dl-sign" aria-label={l.kind === 'add' ? '新增' : l.kind === 'del' ? '删除' : undefined}>
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
              </span>
              <span className="rv-dl-text">{l.text || ' '}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
