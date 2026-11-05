import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, CircleAlert, GitMerge, Lock, Redo2, RotateCw, TriangleAlert, Undo2 } from 'lucide-react'
import type { WorkflowDiagnostic } from '@taktflow/core'
import { StatusDot } from '../../../components/ui'
import { fmtRelative } from '../../../lib/format'
import type { WorkflowDocState } from '../state'
import './collab.css'

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = MAC ? '⌘' : 'Ctrl+'

/** 输入框、文本域、可编辑区域里的 ⌘Z 留给浏览器原生撤销。 */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

function useUndoKeys(wf: WorkflowDocState) {
  const cur = useRef(wf)
  cur.current = wf
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || typing(e.target)) return
      const k = e.key.toLowerCase()
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !MAC)
      if (k !== 'z' && !redo) return
      e.preventDefault()
      void (redo ? cur.current.redo() : cur.current.undo())
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
}

/** 每 30 秒刷新一次"n 分钟前"。 */
function useTick(ms = 30_000) {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

function StatusPill({ wf }: { wf: WorkflowDocState }) {
  useTick()
  const rev = wf.doc?.rev.slice(0, 8)
  switch (wf.status) {
    case 'loading':
      return <span className="wfc-status" role="status">载入中</span>
    case 'saving':
      return (
        <span className="wfc-status is-saving" role="status" title={`基于修订 ${rev} 保存`}>
          <StatusDot tone="running" pulse />
          保存中{wf.pendingWrites > 1 ? `（${wf.pendingWrites} 批）` : ''}
        </span>
      )
    case 'conflict':
      return (
        <span className="wfc-status is-conflict" role="status">
          <GitMerge />
          有冲突，待处理
        </span>
      )
    case 'error':
      return (
        <span className="wfc-status is-error" role="alert" title={wf.error?.message}>
          <AlertTriangle />
          保存失败
          <button className="btn btn-ghost btn-sm wfc-status-retry" onClick={() => void wf.reload()} title="重新读取最新修订">
            <RotateCw />
            重新载入
          </button>
        </span>
      )
    case 'saved':
      return (
        <span className="wfc-status is-saved" role="status" title={wf.savedAt ? `已保存为修订 ${rev}` : `当前修订 ${rev}`}>
          <Check />
          {wf.savedAt ? `已保存 · ${fmtRelative(wf.savedAt)}` : '已是最新'}
          <span className="mono wfc-rev">{rev}</span>
        </span>
      )
  }
}

function DiagnosticsButton({ wf }: { wf: WorkflowDocState }) {
  const diags = wf.doc?.diagnostics ?? []
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  if (diags.length === 0) return null
  const errors = diags.filter((d) => d.severity === 'error').length
  const warnings = diags.length - errors
  return (
    <div className="wfc-diag" ref={box}>
      <button className={`btn btn-ghost btn-sm wfc-diag-btn${errors ? ' is-error' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {errors > 0 ? <CircleAlert /> : <TriangleAlert />}
        {errors > 0 && `${errors} 个错误`}
        {errors > 0 && warnings > 0 && ' · '}
        {warnings > 0 && `${warnings} 个警告`}
      </button>
      {open && (
        <ul className="wfc-diag-pop" aria-label="校验诊断">
          {diags.map((d, i) => <DiagItem key={i} d={d} />)}
        </ul>
      )}
    </div>
  )
}

function DiagItem({ d }: { d: WorkflowDiagnostic }) {
  return (
    <li className={`wfc-diag-item is-${d.severity}`}>
      {d.severity === 'error' ? <CircleAlert aria-label="错误" /> : <TriangleAlert aria-label="警告" />}
      <span className="wfc-diag-msg">{d.message}</span>
      <span className="wfc-diag-where mono">
        {d.nodeId}
        {d.nodeId && d.line ? ' · ' : ''}
        {d.line ? `L${d.line}` : ''}
      </span>
    </li>
  )
}

/** 顶栏：保存状态（基于 baseRev 的乐观锁）+ 撤销 / 重做（⌘Z / ⇧⌘Z）+ 校验诊断。 */
export function SaveStatusBar({ wf }: { wf: WorkflowDocState }) {
  useUndoKeys(wf)
  return (
    <div className="wf-save-status wfc-bar">
      {wf.readOnly ? (
        <span className="wfc-status" title={wf.readOnlyReason}>
          <Lock />
          只读
        </span>
      ) : (
        <StatusPill wf={wf} />
      )}
      <DiagnosticsButton wf={wf} />
      {!wf.readOnly && (
        <span className="wfc-undo" role="group" aria-label="撤销与重做">
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => void wf.undo()} disabled={!wf.canUndo} aria-label="撤销" title={`撤销（${MOD}Z）`}>
            <Undo2 />
          </button>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => void wf.redo()} disabled={!wf.canRedo} aria-label="重做" title={`重做（${MAC ? '⇧⌘Z' : 'Ctrl+Y'}）`}>
            <Redo2 />
          </button>
        </span>
      )}
    </div>
  )
}
