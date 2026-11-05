import { useMemo, useState, type KeyboardEvent } from 'react'
import { FileCode2, Pencil, Save, TriangleAlert } from 'lucide-react'
import { toast } from '../../../components/ui'
import type { WorkflowDocState } from '../state'
import { changedNodeIds, nodeLines } from './changed-nodes'
import { CodeView, type LineMark } from './code-view'
import { DiffStat, DiffView } from './diff-view'
import { collapse, lineDiff } from './line-diff'
import './collab.css'

/** "源码"视图：只读高亮（诊断落到行上、远端变更的节点行高亮），或整文件编辑后 PUT source。 */
export function SourceView({ wf }: { wf: WorkflowDocState }) {
  const [draft, setDraft] = useState<{ text: string; baseRev: string }>()
  const doc = wf.doc
  if (!doc) return null
  return draft ? (
    <SourceEditor wf={wf} draft={draft} setDraft={setDraft} />
  ) : (
    <SourceReader wf={wf} onEdit={() => setDraft({ text: doc.source, baseRev: doc.rev })} />
  )
}

function SourceReader({ wf, onEdit }: { wf: WorkflowDocState; onEdit: () => void }) {
  const doc = wf.doc!
  const lines = useMemo(() => nodeLines(doc.source), [doc.source])
  const marks = useMemo(() => {
    const m = new Map<number, LineMark[]>()
    for (const d of doc.diagnostics) {
      const line = d.line ?? (d.nodeId ? lines.get(d.nodeId) : undefined)
      if (line) m.set(line, [...(m.get(line) ?? []), { severity: d.severity, message: d.message }])
    }
    return m
  }, [doc.diagnostics, lines])
  const highlight = useMemo(() => {
    const ids = changedNodeIds(wf.remoteChange?.before, wf.remoteChange?.after)
    return new Set(ids.flatMap((id) => (lines.has(id) ? [lines.get(id)!] : [])))
  }, [wf.remoteChange, lines])
  const firstMark = marks.size ? Math.min(...marks.keys()) : undefined
  const blocked = wf.status === 'conflict' ? '先处理保存冲突' : undefined

  return (
    <section className="wfc-source" aria-label="源码">
      <div className="wfc-source-bar">
        <FileCode2 />
        <span className="mono">{doc.file}</span>
        <span className="wfc-muted">只读 · {doc.source.split('\n').length} 行</span>
        {marks.size > 0 && (
          <span className="wfc-muted">
            <TriangleAlert className="wfc-inline-icon" /> 诊断已标在对应行
          </span>
        )}
        <span className="wfc-spacer" />
        <button className="btn btn-sm" onClick={onEdit} disabled={!!blocked} title={blocked ?? '整文件编辑，保存时生成一条新修订'}>
          <Pencil />
          编辑源码
        </button>
      </div>
      <CodeView source={doc.source} marks={marks} highlight={highlight} focusLine={firstMark} label={doc.file} />
    </section>
  )
}

function SourceEditor({ wf, draft, setDraft }: { wf: WorkflowDocState; draft: { text: string; baseRev: string }; setDraft: (d?: { text: string; baseRev: string }) => void }) {
  const doc = wf.doc!
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const dirty = draft.text !== doc.source
  const stale = draft.baseRev !== doc.rev
  const rows = useMemo(() => (preview ? collapse(lineDiff(doc.source, draft.text)) : []), [preview, doc.source, draft.text])

  const save = async () => {
    if (busy || !dirty) return
    setBusy(true)
    const ok = await wf.replaceSource(draft.text, reason.trim() || '整文件编辑', draft.baseRev)
    setBusy(false)
    if (!ok) return
    toast('源码已保存', { body: '生成了一条新修订。', tone: 'success' })
    setDraft(undefined)
  }

  const cancel = () => {
    if (dirty && !confirm('放弃对源码的修改？')) return
    setDraft(undefined)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Tab' && !e.shiftKey) {
      // Tab 插入两个空格；按 Esc 后再按 Tab 可以离开文本框
      e.preventDefault()
      const t = e.currentTarget
      const { selectionStart: a, selectionEnd: b } = t
      const text = t.value.slice(0, a) + '  ' + t.value.slice(b)
      setDraft({ ...draft, text })
      requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2))
    } else if (e.key === 'Escape') e.currentTarget.blur()
  }

  return (
    <section className="wfc-source is-editing" aria-label="编辑源码">
      <div className="wfc-source-bar">
        <Pencil />
        <span className="mono">{doc.file}</span>
        <span className="wfc-muted">基于修订 <span className="mono">{draft.baseRev.slice(0, 8)}</span></span>
        <span className="wfc-spacer" />
        <button className="btn btn-ghost btn-sm" aria-pressed={preview} onClick={() => setPreview(!preview)}>
          {preview ? '继续编辑' : '预览改动'}
        </button>
      </div>
      {stale && (
        <div className="wfc-note-row is-warning" role="status">
          <TriangleAlert />
          你开始编辑后 workflow 又有了新修订（{doc.rev.slice(0, 8)}）。保存时会做冲突检查，冲突时可以三方对比后再决定。
        </div>
      )}
      {preview ? (
        <DiffView rows={rows} label="待保存的改动" empty="源码没有改动" />
      ) : (
        <textarea
          className="textarea mono wfc-source-input"
          aria-label="workflow 源码"
          spellCheck={false}
          autoFocus
          value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          onKeyDown={onKey}
        />
      )}
      <div className="wfc-source-foot">
        <input className="input" aria-label="修改原因" placeholder="修改原因（写进修订，可选）" value={reason} onChange={(e) => setReason(e.target.value)} />
        {preview && rows.length > 0 && <DiffStat rows={rows} />}
        <button className="btn btn-ghost btn-sm" onClick={cancel} disabled={busy}>
          取消
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy || !dirty} title={`保存（${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}S）`}>
          <Save />
          {busy ? '保存中…' : '保存源码'}
        </button>
      </div>
    </section>
  )
}
