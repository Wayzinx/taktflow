import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, FileArchive, FolderUp, GitBranch, RotateCcw, Search, X } from 'lucide-react'
import type { SkillImportPreview } from '@taktflow/core'
import { useSource } from '../../api'
import { Dialog, ReasonField, Segmented, reasonOk, toast } from '../../components/ui'
import { UPLOAD_LIMIT, fmtBytes, fromDrop, fromInput, toBase64, type PickedFile } from './skill-upload'

type Mode = 'git' | 'local'
interface Pick {
  on: boolean
  name: string
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 导入技能：Git 仓库（GitHub 网页地址可以直接贴，带 /tree/<分支>/<目录>）或本地文件夹 / zip / .skill。
 * 先预览（服务端拉到暂存区，列出所有带 SKILL.md 的目录），勾选、改名后再导入。
 */
export function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (names: string[]) => void }) {
  const ds = useSource()
  const [mode, setMode] = useState<Mode>('git')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [path, setPath] = useState('')
  const [files, setFiles] = useState<PickedFile[]>([])
  const [over, setOver] = useState(false)
  const [preview, setPreview] = useState<SkillImportPreview>()
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [overwrite, setOverwrite] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const folder = useRef<HTMLInputElement>(null)
  const archive = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setPreview(undefined)
    setFiles([])
    setError(undefined)
    setBusy(false)
    setOverwrite(false)
  }, [open])

  const total = files.reduce((n, f) => n + f.file.size, 0)
  const ready = mode === 'git' ? url.trim() !== '' : files.length > 0 && total <= UPLOAD_LIMIT
  const chosen = preview ? preview.candidates.filter((c) => picks[c.dir]?.on && !c.problem) : []
  const names = chosen.map((c) => picks[c.dir]!.name.trim())
  const clash = chosen.filter((c) => c.exists && picks[c.dir]!.name.trim() === c.name)
  const badName = names.find((n) => !NAME.test(n))
  const dupe = names.find((n, i) => names.indexOf(n) !== i)
  const canImport = chosen.length > 0 && !badName && !dupe && (clash.length === 0 || overwrite) && reasonOk(reason) && !busy

  function addFiles(next: PickedFile[]) {
    if (!next.length) return
    setFiles((prev) => [...prev.filter((p) => !next.some((n) => n.path === p.path)), ...next])
    setError(undefined)
  }

  async function find() {
    if (!ready || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const source = mode === 'git'
        ? { kind: 'git' as const, url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}), ...(path.trim() ? { path: path.trim() } : {}) }
        : { kind: 'upload' as const, files: await Promise.all(files.map(async (f) => ({ path: f.path, base64: await toBase64(f.file) }))) }
      const p = await ds.previewSkillImport(source)
      setPreview(p)
      setPicks(Object.fromEntries(p.candidates.map((c) => [c.dir, { on: !c.problem && (!c.exists || p.candidates.length === 1), name: c.name }])))
      setOverwrite(false)
      setReason(`从 ${p.source} 导入技能`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (!preview || !canImport) return
    setBusy(true)
    setError(undefined)
    try {
      const r = await ds.importSkills({ token: preview.token, picks: chosen.map((c) => ({ dir: c.dir, name: picks[c.dir]!.name.trim() })), overwrite, reason: reason.trim() })
      const replaced = r.imported.filter((x) => x.replaced).map((x) => x.name)
      toast(`已导入 ${r.imported.length} 个技能`, { body: `${r.imported.map((x) => `${x.name}（${x.files} 个文件）`).join('、')}${replaced.length ? `；覆盖了 ${replaced.join('、')}` : ''}。新运行开始时同步给 Agent。` })
      onImported(r.imported.map((x) => x.name))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const set = (dir: string, patch: Partial<Pick>) => setPicks((p) => ({ ...p, [dir]: { ...p[dir]!, ...patch } }))
  const footer = (
    <>
      {error && <span className="ov-error">{error}</span>}
      {preview && (
        <button type="button" className="btn btn-sm" onClick={() => (setPreview(undefined), setError(undefined))} disabled={busy}>
          <RotateCcw />
          换个来源
        </button>
      )}
      <button type="button" className="btn btn-sm" onClick={onClose}>
        取消
      </button>
      {preview ? (
        <button type="button" className="btn btn-sm btn-primary" disabled={!canImport} onClick={submit}>
          {busy ? '导入中…' : `导入 ${chosen.length} 个技能`}
        </button>
      ) : (
        <button type="button" className="btn btn-sm btn-primary" disabled={!ready || busy} onClick={find}>
          <Search />
          {busy ? (mode === 'git' ? '拉取中…' : '解包中…') : '查找技能'}
        </button>
      )}
    </>
  )

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="导入技能" description="一个技能就是一个带 SKILL.md 的文件夹，里面的 references / scripts / assets 一起导入。" dismissible={!busy && !preview} footer={footer}>
      {!preview ? (
        <div className="sk-import">
          <Segmented<Mode>
            ariaLabel="导入来源"
            value={mode}
            onChange={(m) => (setMode(m), setError(undefined))}
            options={[
              { value: 'git', label: 'Git 仓库', icon: GitBranch },
              { value: 'local', label: '本地上传', icon: FolderUp },
            ]}
          />
          {mode === 'git' ? (
            <form className="sk-import-git" onSubmit={(e) => (e.preventDefault(), void find())}>
              <label className="ov-field">
                <span className="ov-field-label">仓库地址</span>
                <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/anthropics/skills/tree/main/skills/pdf" autoFocus data-autofocus spellCheck={false} />
              </label>
              <div className="sk-import-row">
                <label className="ov-field">
                  <span className="ov-field-label">
                    分支 / 标签 / 提交<span className="ov-field-hint">可选，默认主分支</span>
                  </span>
                  <input className="input mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" spellCheck={false} />
                </label>
                <label className="ov-field">
                  <span className="ov-field-label">
                    子目录<span className="ov-field-hint">可选，只拉这一部分</span>
                  </span>
                  <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="skills" spellCheck={false} />
                </label>
              </div>
              <p className="sk-import-hint">支持 GitHub 网页地址、<span className="mono">owner/repo</span> 简写，以及任意 https / SSH 仓库。私有仓库用服务端本机的 git 凭据。会找出目录下所有带 SKILL.md 的文件夹；大仓库建议指定子目录，拉取可能要一两分钟。</p>
              {busy && <p className="sk-import-busy shimmer-text" role="status">从仓库拉取文件，找出带 SKILL.md 的文件夹；大仓库可能要一两分钟</p>}
              <button type="submit" hidden />
            </form>
          ) : (
            <div className="sk-import-local">
              <div
                className={`sk-drop${over ? ' over' : ''}`}
                onDragOver={(e) => (e.preventDefault(), setOver(true))}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(false)
                  void fromDrop(e.dataTransfer).then(addFiles, (err: Error) => toast('读不了拖进来的文件', { body: err.message, tone: 'failed' }))
                }}
              >
                <FolderUp aria-hidden />
                <span>
                  <strong>把技能文件夹或 zip 拖到这里</strong>
                </span>
                <span className="faint">也可以一次拖多个技能；zip / .skill 会在服务端解开</span>
                <span className="sk-drop-actions">
                  <button type="button" className="btn btn-sm" onClick={() => folder.current?.click()}>
                    <FolderUp />
                    选择文件夹
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => archive.current?.click()}>
                    <FileArchive />
                    选择 zip / .skill
                  </button>
                </span>
              </div>
              <input ref={folder} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={(e) => (addFiles(fromInput(e.target.files)), (e.target.value = ''))} />
              <input ref={archive} type="file" hidden multiple accept=".zip,.skill" onChange={(e) => (addFiles(fromInput(e.target.files)), (e.target.value = ''))} />
              {files.length > 0 && (
                <div className="sk-picked">
                  <span className="sk-picked-sum">
                    已选 <b className="num">{files.length}</b> 个文件 · <span className={`num${total > UPLOAD_LIMIT ? ' sk-over' : ''}`}>{fmtBytes(total)}</span>
                    {total > UPLOAD_LIMIT && <span className="sk-over"> 超过 {fmtBytes(UPLOAD_LIMIT)}，请分批或指定 Git 子目录</span>}
                  </span>
                  <span className="sk-picked-list mono truncate">{[...new Set(files.map((f) => f.path.split('/')[0]))].join('、')}</span>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="清空已选文件" onClick={() => setFiles([])}>
                    <X />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : preview.candidates.length === 0 ? (
        <div className="sk-none">
          <AlertTriangle aria-hidden />
          <p>
            在 <span className="mono">{preview.source}</span> 里没找到 SKILL.md。技能文件夹的根目录要有一个 <span className="mono">SKILL.md</span>（开头是 name / description 的 frontmatter）。
          </p>
        </div>
      ) : (
        <div className="sk-cands">
          <p className="sk-cands-head">
            在 <span className="mono">{preview.source}</span> 找到 <b className="num">{preview.candidates.length}</b> 个技能，勾选要导入的；名字就是 skills/ 下的目录名，可以改。
          </p>
          <ul className="sk-cand-list">
            {preview.candidates.map((c) => {
              const p = picks[c.dir]!
              const nameBad = p.on && !NAME.test(p.name.trim())
              const taken = c.exists && p.name.trim() === c.name
              return (
                <li key={c.dir} className={`sk-cand${c.problem ? ' is-blocked' : ''}${p.on ? ' on' : ''}`}>
                  <input type="checkbox" checked={p.on && !c.problem} disabled={!!c.problem} onChange={(e) => set(c.dir, { on: e.target.checked })} aria-label={`导入 ${c.name}`} />
                  <div className="sk-cand-main">
                    <div className="sk-cand-top">
                      <input className={`input mono sk-cand-name${nameBad ? ' is-invalid' : ''}`} value={p.name} disabled={!p.on || !!c.problem} onChange={(e) => set(c.dir, { name: e.target.value })} aria-label={`${c.dir || '根目录'} 导入后的名字`} spellCheck={false} />
                      {taken && <span className="sk-tag warn">{p.on ? '会覆盖' : '已有同名'}</span>}
                      {c.problem && <span className="sk-tag bad">{c.problem}</span>}
                      <span className="spacer" />
                      <span className="faint num sk-cand-meta">
                        {c.files} 个文件 · {fmtBytes(c.bytes)}
                      </span>
                    </div>
                    {c.description ? <p className="sk-cand-desc">{c.description}</p> : <p className="sk-cand-desc faint">没有 description：Agent 不知道什么时候该用它，导入后建议补上</p>}
                    <span className="sk-cand-dir faint mono truncate">{c.dir || '（根目录）'}</span>
                  </div>
                </li>
              )
            })}
          </ul>
          {preview.skipped.length > 0 && (
            <details className="sk-skipped">
              <summary>跳过了 {preview.skipped.length} 项（符号链接、超限文件等）</summary>
              <ul>
                {preview.skipped.map((s) => (
                  <li key={s} className="mono">{s}</li>
                ))}
              </ul>
            </details>
          )}
          {(dupe || badName) && <p className="sk-warn">{dupe ? `名字 ${dupe} 重复了` : `名字 ${badName} 不合法：只能用字母、数字、点、横线和下划线`}</p>}
          {clash.length > 0 && (
            <label className="sk-overwrite">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              覆盖同名技能 <span className="mono">{clash.map((c) => c.name).join('、')}</span>（原来的文件夹整个替换，改过的内容会丢）
            </label>
          )}
          <ReasonField value={reason} onChange={setReason} placeholder="例如：引入官方 PDF 技能，替代手写的抽取脚本" />
        </div>
      )}
    </Dialog>
  )
}
