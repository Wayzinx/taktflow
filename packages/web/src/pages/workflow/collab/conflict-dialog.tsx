import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitMerge } from 'lucide-react'
import { summarizeEdits } from '../../../api/workflow-edit'
import { Segmented, toast } from '../../../components/ui'
import type { ConflictResolution, WorkflowConflictState, WorkflowDocState } from '../state'
import { CodeView } from './code-view'
import { DiffStat, DiffView } from './diff-view'
import { usePersonName } from './revision-author'
import { revisionAuthor } from './revision-who'
import { collapse, conflictCount, hasConflictMarkers, lineDiff } from './line-diff'
import './collab.css'

type Pane = 'merged' | 'ours' | 'theirs' | 'base'

/** 409 冲突：三方对比（基线 / 你的 / 对方的 / 合并结果），选择覆盖、基于最新重做、提交手工合并或放弃。wf.conflict 为空时不渲染。 */
export function ConflictDialog({ wf }: { wf: WorkflowDocState }) {
  if (!wf.conflict) return null
  // 每次新冲突都重置对话框内部状态
  return <ConflictBody key={wf.conflict.conflict.currentRev + wf.conflict.conflict.ours.length} wf={wf} c={wf.conflict} />
}

function ConflictBody({ wf, c }: { wf: WorkflowDocState; c: WorkflowConflictState }) {
  const { base, ours, theirs, merged: initial, currentRev } = c.conflict
  const [pane, setPane] = useState<Pane>('merged')
  const [merged, setMerged] = useState(initial)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const oursRows = useMemo(() => collapse(lineDiff(base, ours)), [base, ours])
  const theirsRows = useMemo(() => collapse(lineDiff(base, theirs)), [base, theirs])
  const left = conflictCount(merged)
  const unresolved = hasConflictMarkers(merged)
  const remote = wf.remoteChange?.event.revision
  const person = usePersonName()
  const who = remote && remote.rev === currentRev ? revisionAuthor(remote, person).name : '其他人'

  const mergeInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])
  // 合并结果打开时直接滚到第一处冲突
  useEffect(() => {
    const t = mergeInput.current
    if (pane !== 'merged' || !t) return
    const at = t.value.split('\n').findIndex((l) => l.startsWith('<<<<<<<'))
    if (at < 0) return
    t.scrollTop = Math.max(0, at * parseFloat(getComputedStyle(t).lineHeight) - 48)
  }, [pane])

  const resolve = async (r: ConflictResolution, done: string) => {
    setBusy(true)
    const ok = await wf.resolveConflict(r)
    setBusy(false)
    if (ok) toast(done, { tone: 'success' })
  }

  return createPortal(
    <div className="wfc-modal-layer">
      <div className="wfc-scrim" aria-hidden />
      <div className="wfc-modal wfc-conflict" role="alertdialog" aria-modal="true" aria-labelledby="wfc-conflict-title" aria-describedby="wfc-conflict-desc" ref={box} tabIndex={-1}>
        <header className="wfc-modal-head">
          <span className="wfc-modal-icon">
            <GitMerge />
          </span>
          <div>
            <h2 className="wfc-modal-title" id="wfc-conflict-title">
              保存冲突：{who} 刚修改了同一处
            </h2>
            <p className="wfc-modal-desc" id="wfc-conflict-desc">
              你的修改（{c.edits.length ? summarizeEdits(c.edits) : '整文件编辑'}）基于旧修订，自动合并失败。最新修订是 <span className="mono">{currentRev.slice(0, 8)}</span>
              {remote?.rev === currentRev && remote.summary ? `：${remote.summary}` : ''}。
            </p>
          </div>
        </header>

        <div className="wfc-modal-tools">
          <Segmented<Pane>
            options={[
              { value: 'merged', label: left ? `合并结果 · ${left} 处冲突` : '合并结果' },
              { value: 'ours', label: '你的 vs 基线' },
              { value: 'theirs', label: '对方的 vs 基线' },
              { value: 'base', label: '基线' },
            ]}
            value={pane}
            onChange={setPane}
          />
          <span className="wfc-spacer" />
          {pane === 'ours' && <DiffStat rows={oursRows} />}
          {pane === 'theirs' && <DiffStat rows={theirsRows} />}
        </div>

        <div className="wfc-modal-body">
          {pane === 'merged' && (
            <>
              <p className="wfc-hint">
                在 <span className="mono">{'<<<<<<< 你的修改'}</span> 与 <span className="mono">{'>>>>>>> 最新修订'}</span> 之间选定保留的内容，删掉标记行后即可提交。
              </p>
              <textarea ref={mergeInput} className="textarea mono wfc-merge-input" aria-label="合并结果" spellCheck={false} value={merged} onChange={(e) => setMerged(e.target.value)} />
            </>
          )}
          {pane === 'ours' && <DiffView rows={oursRows} label="你的改动" empty="你的一侧与基线相同" />}
          {pane === 'theirs' && <DiffView rows={theirsRows} label="对方的改动" empty="对方一侧与基线相同" />}
          {pane === 'base' && <CodeView source={base} label="基线源码" />}
        </div>

        <footer className="wfc-modal-foot">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolve({ kind: 'discard' }, '已放弃你的修改，载入最新修订')}>
            放弃我的修改
          </button>
          <span className="wfc-spacer" />
          <button className={`btn btn-sm${confirmOverwrite ? ' btn-danger' : ''}`} disabled={busy} onClick={() => (confirmOverwrite ? void resolve({ kind: 'overwrite' }, '已用你的版本覆盖') : setConfirmOverwrite(true))} onBlur={() => setConfirmOverwrite(false)}>
            {confirmOverwrite ? '确认覆盖对方的修改' : '用我的覆盖'}
          </button>
          <button className="btn btn-sm" disabled={busy || c.edits.length === 0} title={c.edits.length ? '载入最新修订，在其上重新应用你的编辑' : '整文件编辑无法自动重做，请手工合并'} onClick={() => void resolve({ kind: 'rebase' }, '已基于最新修订重做你的编辑')}>
            基于最新重做
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy || unresolved} title={unresolved ? '还有冲突标记没处理' : '把合并结果作为新修订保存'} onClick={() => void resolve({ kind: 'source', source: merged }, '合并结果已保存')}>
            提交合并结果
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
