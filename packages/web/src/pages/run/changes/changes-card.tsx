import { useState, type CSSProperties } from 'react'
import { ChevronDown, FileDiff, History, Undo2 } from 'lucide-react'
import type { NodeChanges } from '@taktflow/core'
import { DiffDialog } from './diff-dialog'
import { RewindDialog } from './rewind-dialog'
import './changes.css'

type File = NodeChanges['files'][number]

const STATUS: Record<File['status'], { glyph: string; label: string }> = {
  added: { glyph: 'A', label: '新增' },
  modified: { glyph: 'M', label: '修改' },
  deleted: { glyph: 'D', label: '删除' },
  renamed: { glyph: 'R', label: '改名' },
}

/** 五格增删条：按 +A −D 的比例染绿 / 红，其余灰（与 git 的 diffstat 一个意思）。 */
export function DeltaBar({ add, del }: { add: number; del: number }) {
  const total = add + del
  const g = total ? Math.round((add / total) * 5) : 0
  const r = total ? Math.min(5 - g, Math.max(del ? 1 : 0, Math.round((del / total) * 5))) : 0
  return (
    <span className="delta" aria-label={`新增 ${add} 行，删除 ${del} 行`}>
      <span className="delta-num mono num">
        <b className="is-add">+{add}</b>
        <b className="is-del">−{del}</b>
      </span>
      <span className="delta-bar" aria-hidden>
        {Array.from({ length: 5 }, (_, i) => (
          <i key={i} className={i < g ? 'is-add' : i < g + r ? 'is-del' : ''} />
        ))}
      </span>
    </span>
  )
}

function FileRow({ f, i, onDiff }: { f: File; i: number; onDiff: () => void }) {
  const slash = f.path.lastIndexOf('/')
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : ''
  const base = f.path.slice(slash + 1)
  const st = STATUS[f.status]
  return (
    <li className="chg-row" style={{ '--i': i } as CSSProperties}>
      <button className="chg-file" onClick={onDiff} title={`${st.label} ${f.path}，点开看 diff`}>
        <span className={`chg-st st-${f.status}`} aria-label={st.label}>
          {st.glyph}
        </span>
        <span className="chg-path truncate">
          <span className="faint">{dir}</span>
          {base}
        </span>
        {f.scope === 'repo' ? (
          <span className="chg-scope mono" title="代码仓库（worktree）">{f.repo ?? 'repo'}</span>
        ) : (
          <span className="chg-scope is-ws" title="存放区产物版本">
            存放区 {f.from ? `v${f.from} → ` : ''}v{f.to}
          </span>
        )}
        <DeltaBar add={f.add} del={f.del} />
      </button>
    </li>
  )
}

/**
 * 节点改动卡（docs/design/26 §5）：本节点改了哪些文件；默认 3 行可展开；
 * "退回到这个节点之前"不能用时置灰并写明原因，而不是藏起来。
 */
export function ChangesCard({ runId, nodeId, nodeTitle, changes, limit = 3, bare }: { runId: string; nodeId: string; nodeTitle: string; changes: NodeChanges; limit?: number; bare?: boolean }) {
  const [all, setAll] = useState(false)
  const [diff, setDiff] = useState<{ path?: string } | null>(null)
  const [rewind, setRewind] = useState(false)
  const files = changes.files
  const shown = all ? files : files.slice(0, limit)
  const repo = files.filter((f) => f.scope === 'repo').length
  return (
    <section className={`chg${bare ? ' is-bare' : ''}`} aria-label="本节点的改动">
      <header className="chg-head">
        <FileDiff />
        <b>改了 {files.length} 个文件</b>
        {files.length > 0 && <DeltaBar add={changes.add} del={changes.del} />}
        <span className="chg-split faint">
          {repo > 0 && `仓库 ${repo}`}
          {repo > 0 && repo < files.length && ' · '}
          {repo < files.length && `存放区 ${files.length - repo}`}
        </span>
      </header>
      {files.length > 0 ? (
        <ul className="chg-list">
          {shown.map((f, i) => (
            <FileRow key={`${f.scope}:${f.path}`} f={f} i={i >= limit ? i - limit : 0} onDiff={() => setDiff({ path: f.path })} />
          ))}
        </ul>
      ) : (
        <p className="chg-empty faint">这个节点没有改动文件。</p>
      )}
      <footer className="chg-foot">
        {files.length > limit && (
          <button className="btn btn-ghost btn-xs" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            <ChevronDown className={all ? 'flip' : undefined} />
            {all ? '收起' : `展开全部 ${files.length} 个`}
          </button>
        )}
        {files.length > 1 && (
          <button className="btn btn-ghost btn-xs" onClick={() => setDiff({})}>
            <History />
            看全部 diff
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn btn-xs" disabled={Boolean(changes.rewindBlocked)} onClick={() => setRewind(true)} title={changes.rewindBlocked ?? '先预览会恢复哪些文件、哪些节点会过期，确认后才执行'}>
          <Undo2 />
          退回到这个节点之前
        </button>
      </footer>
      {changes.rewindBlocked && files.length > 0 && <p className="chg-blocked">{changes.rewindBlocked}</p>}
      <DiffDialog open={diff !== null} onClose={() => setDiff(null)} runId={runId} nodeId={nodeId} path={diff?.path} files={files} />
      <RewindDialog open={rewind} onClose={() => setRewind(false)} runId={runId} nodeId={nodeId} nodeTitle={nodeTitle} />
    </section>
  )
}
