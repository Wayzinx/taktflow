import { useEffect, useMemo, useRef, useState } from 'react'
import { History, X } from 'lucide-react'
import type { WorkflowRevision } from '@taktflow/core'
import { useAsync } from '../../../api'
import { TaktLoader } from '../../../components/takt'
import { Avatar, EmptyState, ErrorState, Segmented } from '../../../components/ui'
import { actorName, fmtDate, fmtRelative } from '../../../lib/format'
import type { WorkflowDocState } from '../state'
import { DiffStat, DiffView } from './diff-view'
import { collapse, lineDiff, parseUnifiedDiff } from './line-diff'
import { RollbackForm } from './rollback-form'
import './collab.css'

type Compare = 'parent' | 'current'

/** 修订历史抽屉：左侧修订列表，右侧选中修订与父修订（或当前版本）的 diff，可回滚。 */
export function RevisionsDrawer({ wf, workflowId, open, onClose }: { wf: WorkflowDocState; workflowId: string; open: boolean; onClose: () => void }) {
  const head = wf.doc?.rev
  const list = useAsync((ds) => (open ? ds.workflowRevisions(workflowId) : Promise.resolve(undefined)), [workflowId, open, head])
  // 修订列表随 head 刷新；刷新期间保留上一份，避免闪成加载态
  const last = useRef<WorkflowRevision[]>(undefined)
  if (list.data) last.current = list.data
  const revs = list.data ?? last.current
  // 打开时默认选中：远端刚改的那条，否则当前修订
  const [sel, setSel] = useState<string>()
  const [compare, setCompare] = useState<Compare>('parent')
  const panel = useRef<HTMLElement>(null)
  const opener = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    setSel(wf.remoteChange?.event.revision.rev ?? head)
    setCompare('parent')
    opener.current = document.activeElement
    panel.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('keydown', esc)
      if (opener.current instanceof HTMLElement) opener.current.focus()
    }
    // 只在打开的那一刻定位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  const current = revs?.find((r) => r.rev === sel) ?? revs?.[0]

  return (
    <div className="wfc-drawer-layer">
      <div className="wfc-scrim" onClick={onClose} aria-hidden />
      <aside className="wfc-drawer" role="dialog" aria-modal="true" aria-label="修订历史" ref={panel} tabIndex={-1}>
        <header className="wfc-drawer-head">
          <History />
          <h2 className="wfc-drawer-title">修订历史</h2>
          <span className="mono wfc-muted">{wf.doc?.file}</span>
          <button className="btn btn-ghost btn-icon btn-sm wfc-drawer-close" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>
        {list.error && !revs ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : !revs ? (
          <TaktLoader label="正在读取修订历史" />
        ) : revs.length === 0 ? (
          <EmptyState icon={History} title="还没有修订" hint="保存一次之后这里会出现第一条修订。" />
        ) : (
          <div className="wfc-drawer-body">
            <ol className="wfc-rev-list" aria-label="修订">
              {revs.map((r) => (
                <li key={r.rev}>
                  <button className={`wfc-rev${r.rev === current?.rev ? ' is-selected' : ''}`} aria-current={r.rev === current?.rev ? 'true' : undefined} onClick={() => setSel(r.rev)}>
                    <span className="wfc-rev-top">
                      <Avatar name={actorName(r.author)} size={18} />
                      <span className="wfc-rev-author">{actorName(r.author)}</span>
                      <span className="wfc-muted" title={fmtDate(r.at)}>{fmtRelative(r.at)}</span>
                    </span>
                    <span className="wfc-rev-summary">{r.summary ?? r.reason ?? '（无摘要）'}</span>
                    <span className="wfc-rev-tags">
                      <span className="mono wfc-muted">{r.rev.slice(0, 8)}</span>
                      {r.rev === head && <span className="chip wfc-chip-current">当前</span>}
                      {r.rev === wf.remoteChange?.event.revision.rev && <span className="chip wfc-chip-remote">刚刚</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {current && <RevisionDetail key={current.rev} wf={wf} workflowId={workflowId} rev={current} isHead={current.rev === head} compare={compare} setCompare={setCompare} />}
          </div>
        )}
      </aside>
    </div>
  )
}

function RevisionDetail({ wf, workflowId, rev, isHead, compare, setCompare }: { wf: WorkflowDocState; workflowId: string; rev: WorkflowRevision; isHead: boolean; compare: Compare; setCompare: (c: Compare) => void }) {
  const detail = useAsync((ds) => ds.workflowRevision(workflowId, rev.rev), [workflowId, rev.rev])
  const current = wf.doc?.source
  const mode: Compare = isHead ? 'parent' : compare
  const rows = useMemo(() => {
    if (!detail.data) return []
    // 与当前版本比：方向是"回滚会带来什么"——当前 → 该修订
    if (mode === 'current') return current === undefined ? [] : collapse(lineDiff(current, detail.data.source))
    return parseUnifiedDiff(detail.data.diff)
  }, [detail.data, mode, current])

  return (
    <section className="wfc-rev-detail" aria-label={`修订 ${rev.rev.slice(0, 8)}`}>
      <div className="wfc-rev-meta">
        <div className="wfc-rev-heading">{rev.summary ?? '（无摘要）'}</div>
        {rev.reason && <p className="wfc-rev-reason">{rev.reason}</p>}
        <dl className="wfc-kv">
          <dt>作者</dt>
          <dd>{actorName(rev.author)}</dd>
          <dt>时间</dt>
          <dd>{fmtDate(rev.at)}</dd>
          <dt>修订</dt>
          <dd className="mono">
            {rev.rev.slice(0, 12)}
            {rev.parent && <span className="wfc-muted"> ← {rev.parent.slice(0, 8)}</span>}
          </dd>
        </dl>
        <div className="wfc-rev-actions">
          {!isHead && (
            <Segmented<Compare>
              options={[
                { value: 'parent', label: '与上一修订' },
                { value: 'current', label: '与当前版本' },
              ]}
              value={mode}
              onChange={setCompare}
            />
          )}
          {rows.length > 0 && <DiffStat rows={rows} />}
          <span className="wfc-spacer" />
          {!isHead && <RollbackForm wf={wf} rev={rev} onDone={() => setCompare('parent')} />}
        </div>
      </div>
      {detail.error ? (
        <ErrorState error={detail.error} onRetry={detail.reload} />
      ) : !detail.data ? (
        <TaktLoader compact label="正在读取差异" />
      ) : (
        <DiffView rows={rows} label="修订差异" empty={mode === 'current' ? '与当前版本相同' : rev.parent ? '与上一修订相同' : '这是第一条修订，没有可比较的父修订'} />
      )}
    </section>
  )
}
