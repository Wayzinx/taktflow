import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, File, FileCode2, FileImage, FilePlus2, FileText, Folder, Import, MoreHorizontal, Plus, Save, Trash2, Upload } from 'lucide-react'
import type { SkillFileEntry, SkillRecord, SpaceDetail } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { Dialog, EmptyState, ErrorState, Menu, ReasonDialog, ReasonField, Segmented, SkeletonRows, reasonOk, toast, useStagger } from '../../components/ui'
import { setQuery, useLocation } from '../../lib/router'
import { StewardEditButton } from './ask-steward'
import { ImportDialog } from './skill-import'
import { FILE_LIMIT, fmtBytes, fromInput, toBase64, type PickedFile } from './skill-upload'
import './space-files.css'
import './skills.css'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const dirOf = (s: SkillRecord) => s.dir ?? s.path.split('/').at(-2) ?? s.name

function changedLines(a: string, b: string): number {
  const x = a.split('\n')
  const y = b.split('\n')
  let n = Math.abs(x.length - y.length)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++
  return n
}

function fileIcon(path: string) {
  if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(path)) return FileImage
  if (/\.(py|sh|js|mjs|ts|rb|go|rs|ps1|bat)$/i.test(path)) return FileCode2
  if (/\.(md|txt|rst)$/i.test(path)) return FileText
  return File
}

type Row = { kind: 'dir'; path: string; name: string; depth: number } | { kind: 'file'; path: string; name: string; depth: number; f: SkillFileEntry }

/** 平铺路径 → 带缩进的树行（目录在前，SKILL.md 永远第一行）。 */
function treeRows(files: SkillFileEntry[], closed: Set<string>): Row[] {
  const rows: Row[] = []
  const seen = new Set<string>()
  const sorted = [...files].sort((a, b) => {
    if (a.path === 'SKILL.md') return -1
    if (b.path === 'SKILL.md') return 1
    const da = a.path.includes('/'), db = b.path.includes('/')
    return da !== db ? (da ? -1 : 1) : a.path.localeCompare(b.path)
  })
  for (const f of sorted) {
    const segs = f.path.split('/')
    let hidden = false
    for (let i = 0; i < segs.length - 1; i++) {
      const dir = segs.slice(0, i + 1).join('/')
      if (!hidden && !seen.has(dir)) {
        seen.add(dir)
        rows.push({ kind: 'dir', path: dir, name: segs[i]!, depth: i })
      }
      if (closed.has(dir)) hidden = true
    }
    if (!hidden) rows.push({ kind: 'file', path: f.path, name: segs.at(-1)!, depth: segs.length - 1, f })
  }
  return rows
}

function FileEditor({ skill, path, onDirty, onSaved, onDelete }: { skill: string; path: string; onDirty: (dirty: boolean) => void; onSaved: () => void; onDelete: () => void }) {
  const ds = useSource()
  const q = useAsync((d) => d.skillFile(skill, path), [skill, path])
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const original = q.data?.text ? q.data.content : undefined
  useEffect(() => {
    if (original !== undefined) setText(original)
    setReason('')
  }, [original])
  const changed = original === undefined ? 0 : changedLines(original, text)
  useEffect(() => onDirty(changed > 0), [changed > 0])
  useEffect(() => () => onDirty(false), [])

  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data) return <SkeletonRows rows={10} />
  const canSave = changed > 0 && reason.trim() !== '' && !busy
  const Icon = fileIcon(path)

  async function save() {
    if (!canSave) return
    setBusy(true)
    try {
      await ds.saveSkillFile(skill, path, { content: text, reason: reason.trim() })
      toast(`已保存 skills/${skill}/${path}`, { body: `原因：${reason.trim()}。新运行开始时整个技能文件夹同步给 Agent。` })
      q.reload()
      onSaved()
    } catch (e) {
      toast('保存失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  const head = (
    <div className="file-editor-head">
      <Icon aria-hidden />
      <span className="mono truncate">{path}</span>
      <span className="faint num">{fmtBytes(q.data.size)}</span>
      <span className="spacer" />
      {q.data.text && (changed > 0 ? <span className="file-dirty">改动 <span className="num">{changed}</span> 行</span> : <span className="faint">未修改</span>)}
      {path !== 'SKILL.md' && (
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`删除 ${path}`} title="删除这个文件" onClick={onDelete}>
          <Trash2 />
        </button>
      )}
    </div>
  )
  if (!q.data.text)
    return (
      <div className="file-editor">
        {head}
        <div className="sk-binary">
          <Icon aria-hidden />
          <p>
            二进制文件，不能在线编辑。<br />
            <span className="faint">要换内容就用「添加文件」上传同名文件覆盖。</span>
          </p>
        </div>
      </div>
    )
  return (
    <div
      className="file-editor"
      onKeyDown={(e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          void save()
        }
      }}
    >
      {head}
      <textarea className="textarea mono file-text" spellCheck={false} aria-label={`${path} 内容`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="file-save">
        <label className="grow">
          <span className="field-label">修改原因（必填，写进修订记录）</span>
          <input className="input" placeholder={changed ? '例如：补充舍入方式示例' : '修改内容后填写'} value={reason} onChange={(e) => setReason(e.target.value)} disabled={changed === 0} aria-required />
        </label>
        <button className="btn" onClick={() => setText(original ?? '')} disabled={changed === 0 || busy}>
          还原
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!canSave} title="⌘S / Ctrl+S">
          <Save />
          保存
        </button>
      </div>
      {changed > 0 && !reason.trim() && <p className="file-save-hint">写一句修改原因才能保存：它和改动一起进修订记录，方便回看为什么这么改。</p>}
    </div>
  )
}

/** 往技能里加文件：新建空的文本文件，或上传（脚本、图片、模板……）。 */
function AddFileDialog({ skill, open, onClose, onAdded }: { skill: string; open: boolean; onClose: () => void; onAdded: (path: string) => void }) {
  const ds = useSource()
  const [mode, setMode] = useState<'new' | 'upload'>('new')
  const [path, setPath] = useState('references/')
  const [dir, setDir] = useState('assets')
  const [files, setFiles] = useState<PickedFile[]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    setPath('references/')
    setFiles([])
    setReason('')
    setError(undefined)
  }, [open])
  const big = files.find((f) => f.file.size > FILE_LIMIT)
  const target = (f: PickedFile) => [dir.trim().replace(/^\/+|\/+$/g, ''), f.file.name].filter(Boolean).join('/')
  const pathOk = mode === 'new' ? /^[^/].*[^/]$/.test(path.trim()) && path.trim() !== 'SKILL.md' : files.length > 0 && !big
  async function submit() {
    if (!pathOk || !reasonOk(reason) || busy) return
    setBusy(true)
    setError(undefined)
    try {
      if (mode === 'new') {
        await ds.saveSkillFile(skill, path.trim(), { content: '', reason: reason.trim() })
        onAdded(path.trim())
      } else {
        for (const f of files) await ds.saveSkillFile(skill, target(f), { base64: await toBase64(f.file), reason: reason.trim() })
        toast(`已上传 ${files.length} 个文件到 skills/${skill}/${dir.trim() || ''}`)
        onAdded(target(files[0]!))
      }
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`给 ${skill} 添加文件`}
      description="参考资料放 references/，可执行脚本放 scripts/，模板和图片放 assets/；在 SKILL.md 里写明什么时候读哪个。"
      dismissible={!busy && !files.length}
      footer={
        <>
          {error && <span className="ov-error">{error}</span>}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!pathOk || !reasonOk(reason) || busy} onClick={submit}>
            {busy ? '提交中…' : mode === 'new' ? '新建' : `上传 ${files.length || ''} 个文件`}
          </button>
        </>
      }
    >
      <form className="ov-form sk-add" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Segmented<'new' | 'upload'>
          size="sm"
          ariaLabel="新建或上传"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'new', label: '新建文本文件', icon: FilePlus2 },
            { value: 'upload', label: '上传文件', icon: Upload },
          ]}
        />
        {mode === 'new' ? (
          <label className="ov-field">
            <span className="ov-field-label">路径（相对技能目录）</span>
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="references/guide.md" autoFocus data-autofocus spellCheck={false} />
          </label>
        ) : (
          <>
            <label className="ov-field">
              <span className="ov-field-label">
                放到目录<span className="ov-field-hint">留空 = 技能根目录</span>
              </span>
              <input className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="assets" spellCheck={false} />
            </label>
            <div className="sk-add-files">
              <button type="button" className="btn btn-sm" onClick={() => input.current?.click()}>
                <Upload />
                选择文件
              </button>
              <span className="faint truncate">{files.length ? files.map((f) => f.file.name).join('、') : `单个不超过 ${fmtBytes(FILE_LIMIT)}，同名会覆盖`}</span>
              <input ref={input} type="file" multiple hidden onChange={(e) => (setFiles(fromInput(e.target.files)), (e.target.value = ''))} />
            </div>
            {big && <p className="sk-warn">{big.file.name} 超过 {fmtBytes(FILE_LIMIT)}，放不进技能</p>}
          </>
        )}
        <ReasonField value={reason} onChange={setReason} placeholder="例如：补充表单字段说明，SKILL.md 里引用" />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function CreateSkillDialog({ open, onClose, onCreated, taken }: { open: boolean; onClose: () => void; onCreated: (name: string) => void; taken: string[] }) {
  const ds = useSource()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!open) return
    setName('')
    setDesc('')
    setReason('')
    setError(undefined)
  }, [open])
  const n = name.trim()
  const nameError = !n ? undefined : !NAME.test(n) ? '只能用字母、数字、点、横线和下划线，最多 64 个字符' : taken.includes(n) ? '已有同名技能' : undefined
  const ok = !!n && !nameError && desc.trim() !== '' && reasonOk(reason) && !busy
  async function submit() {
    if (!ok) return
    setBusy(true)
    setError(undefined)
    try {
      await ds.saveSkillFile(n, 'SKILL.md', { content: `---\nname: ${n}\ndescription: ${desc.trim()}\n---\n\n# ${n}\n\n`, reason: reason.trim() })
      toast(`已新建技能 ${n}`, { body: '接着在 SKILL.md 里写做法；参考资料和脚本用「添加文件」放进来。' })
      onCreated(n)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建技能"
      description="会建 skills/<名字>/SKILL.md。description 决定 Agent 什么时候想起用它，写清楚适用场景。"
      dismissible={!n && !desc}
      footer={
        <>
          {error && <span className="ov-error">{error}</span>}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!ok} onClick={submit}>
            {busy ? '提交中…' : '新建'}
          </button>
        </>
      }
    >
      <form className="ov-form" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <label className="ov-field">
          <span className="ov-field-label">
            名字<span className="ov-field-hint">也是目录名</span>
          </span>
          <input className={`input mono${nameError ? ' is-invalid' : ''}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="money-format" autoFocus data-autofocus spellCheck={false} />
          {nameError && <span className="sk-warn">{nameError}</span>}
        </label>
        <label className="ov-field">
          <span className="ov-field-label">description</span>
          <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="金额字段的格式化与舍入规则：导出 CSV、对账时使用" />
        </label>
        <ReasonField value={reason} onChange={setReason} placeholder="例如：把对账口径沉淀下来，避免每次在需求里重复" />
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function SkillPane({ record, file, onChanged, onDeleted }: { record: SkillRecord; file?: string; onChanged: () => void; onDeleted: () => void }) {
  const ds = useSource()
  const name = dirOf(record)
  const tree = useAsync((d) => d.skillTree(name), [name])
  const [dirty, setDirty] = useState(false)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string>()
  const [menu, setMenu] = useState(false)
  const [dropping, setDropping] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const files = tree.data?.files ?? []
  const current = files.some((f) => f.path === file) ? file! : 'SKILL.md'
  const rows = useMemo(() => treeRows(files, closed), [files, closed])
  const bytes = files.reduce((n, f) => n + f.size, 0)
  const open = (path: string) => {
    if (path === current) return
    if (dirty && !window.confirm(`${current} 有未保存的修改，切换后会丢失。继续？`)) return
    setQuery({ file: path === 'SKILL.md' ? undefined : path })
  }

  return (
    <div className="card sk-pane">
      <header className="sk-head">
        <span className="sk-head-title">
          <b className="mono truncate">{record.name}</b>
          <span className="faint mono truncate">
            skills/{name}/{tree.data && <> · {files.length} 个文件 · {fmtBytes(bytes)}</>}
          </span>
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
          <Plus />
          添加文件
        </button>
        <button ref={more} type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`${record.name} 的更多操作`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(true)}>
          <MoreHorizontal />
        </button>
        <Menu open={menu} onClose={() => setMenu(false)} anchor={more} placement="bottom-end" items={[{ id: 'delete', label: '删除技能', icon: Trash2, danger: true, onSelect: () => setDropping(true) }]} />
      </header>
      {tree.error && !tree.data ? (
        <ErrorState error={tree.error} onRetry={tree.reload} />
      ) : !tree.data ? (
        <SkeletonRows rows={8} />
      ) : (
        <div className="sk-body">
          <nav className="sk-tree" aria-label={`${record.name} 的文件`}>
            {rows.map((r) =>
              r.kind === 'dir' ? (
                <button
                  key={`d:${r.path}`}
                  type="button"
                  className={`sk-row sk-dir${closed.has(r.path) ? ' is-closed' : ''}`}
                  style={{ paddingLeft: 8 + r.depth * 14 }}
                  aria-expanded={!closed.has(r.path)}
                  onClick={() => setClosed((s) => {
                    const next = new Set(s)
                    if (!next.delete(r.path)) next.add(r.path)
                    return next
                  })}
                >
                  <ChevronDown className="sk-chev" aria-hidden />
                  <Folder aria-hidden />
                  <span className="truncate">{r.name}</span>
                </button>
              ) : (
                <button key={`f:${r.path}`} type="button" className={`sk-row sk-file${r.path === current ? ' on' : ''}`} style={{ paddingLeft: 8 + r.depth * 14 + 14 }} aria-current={r.path === current ? 'true' : undefined} onClick={() => open(r.path)} title={r.path}>
                  {(() => {
                    const Icon = fileIcon(r.path)
                    return <Icon aria-hidden />
                  })()}
                  <span className={`truncate${r.path === 'SKILL.md' ? ' sk-main' : ''}`}>{r.name}</span>
                  {dirty && r.path === current && <span className="file-item-dirty">未保存</span>}
                  <span className="sk-size faint num">{fmtBytes(r.f.size)}</span>
                </button>
              ),
            )}
            {files.length === 1 && <p className="sk-tree-tip">只有 SKILL.md。长的参考资料、可执行脚本、模板可以拆成单独文件，Agent 用到时再读，省上下文。</p>}
          </nav>
          <FileEditor key={`${name}:${current}`} skill={name} path={current} onDirty={setDirty} onSaved={() => (tree.reload(), current === 'SKILL.md' && onChanged())} onDelete={() => setRemoving(current)} />
        </div>
      )}
      <AddFileDialog skill={name} open={adding} onClose={() => setAdding(false)} onAdded={(path) => (tree.reload(), setQuery({ file: path }))} />
      <ReasonDialog
        open={!!removing}
        onClose={() => setRemoving(undefined)}
        risk="write"
        title={`删除 ${removing ?? ''}`}
        description={`从 skills/${name}/ 删掉这个文件。别忘了改 SKILL.md 里引用它的地方。`}
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await ds.deleteSkillFile(name, removing!, reason)
          toast(`已删除 ${removing}`)
          setQuery({ file: undefined })
          tree.reload()
        }}
      />
      <ReasonDialog
        open={dropping}
        onClose={() => setDropping(false)}
        risk="dangerous"
        title={`删除技能 ${record.name}`}
        description={`整个删掉 skills/${name}/（${files.length} 个文件）。引用它的角色档案会提示技能不存在。`}
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await ds.deleteSkill(name, reason)
          toast(`已删除技能 ${record.name}`)
          onDeleted()
        }}
      />
    </div>
  )
}

/** 空间设置 · 技能：每个技能是一个文件夹（SKILL.md + references / scripts / assets），可以从 Git 仓库或本地导入。 */
export function SkillsTab({ space, onChanged }: { space?: SpaceDetail; onChanged?: () => void }) {
  const { query } = useLocation()
  const [importing, setImporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const list = space?.skills ?? []
  const st = useStagger(list.length)
  if (!space) return <div className="card"><SkeletonRows rows={6} /></div>
  const dialogs = (
    <>
      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={(names) => (onChanged?.(), setQuery({ name: names[0], file: undefined }))} />
      <CreateSkillDialog open={creating} onClose={() => setCreating(false)} taken={list.map(dirOf)} onCreated={(n) => (onChanged?.(), setQuery({ name: n, file: undefined }))} />
    </>
  )
  const actions = (
    <>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setImporting(true)}>
        <Import />
        导入技能
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
        <Plus />
        新建
      </button>
    </>
  )
  if (list.length === 0)
    return (
      <div className="card">
        <EmptyState
          title="还没有技能"
          body="技能是一个文件夹：SKILL.md 写做法，references / scripts / assets 放参考资料、脚本和模板，运行前整个同步给每个 Agent。可以从 GitHub 等 Git 仓库导入，也可以上传本地文件夹或 zip。"
          action={<span className="sk-empty-actions">{actions}</span>}
          stewardAsk="帮我新建一个技能，内容是："
        />
        {dialogs}
      </div>
    )
  const selected = list.find((s) => dirOf(s) === query.get('name')) ?? list[0]!
  return (
    <div className="files-layout sk-layout">
      <div className="card sk-side">
        <div className="sk-side-actions">{actions}</div>
        <ul className="file-list sk-list" aria-label="技能列表">
          {list.map((s, i) => (
            <li key={dirOf(s)} {...st(i)}>
              <button type="button" className={`file-item${s === selected ? ' on' : ''}`} aria-current={s === selected ? 'true' : undefined} onClick={() => s !== selected && setQuery({ name: dirOf(s), file: undefined })}>
                <span className="file-item-title">
                  <span className="mono">{s.name}</span>
                  {dirOf(s) !== s.name && <span className="faint mono">{dirOf(s)}/</span>}
                </span>
                <span className="file-item-desc">{s.description || '（没有 description）'}</span>
              </button>
            </li>
          ))}
          <li className="file-list-foot">
            <StewardEditButton ask="帮我新建一个技能，内容是：" label="让管家新建技能" ghost />
          </li>
        </ul>
      </div>
      <SkillPane key={dirOf(selected)} record={selected} file={query.get('file') ?? undefined} onChanged={() => onChanged?.()} onDeleted={() => (onChanged?.(), setQuery({ name: undefined, file: undefined }))} />
      {dialogs}
    </div>
  )
}
