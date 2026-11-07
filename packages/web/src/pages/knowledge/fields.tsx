import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { FileUp, KeyRound, Plus, X } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { Chip, toast } from '../../components/ui'

/** 待上传文件（读成文本；二进制格式本期只取纯文本，见 docs/design/23「不做什么」）。 */
export interface PendingFile {
  path: string
  content: string
  bytes: number
}
const ACCEPT = ['md', 'txt', 'html', 'json', 'csv']

/** 拖拽上传：拖入或点击选择；只收 md / txt / html / json / csv。 */
export function Dropzone({ files, onChange }: { files: PendingFile[]; onChange: (f: PendingFile[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  async function add(list: FileList | null) {
    if (!list) return
    const picked = [...list]
    const ok = picked.filter((f) => ACCEPT.includes(f.name.split('.').pop()?.toLowerCase() ?? ''))
    const read = await Promise.all(ok.map(async (f) => ({ path: f.webkitRelativePath || f.name, content: await f.text(), bytes: f.size })))
    const merged = [...files.filter((x) => !read.some((r) => r.path === x.path)), ...read]
    onChange(merged)
    if (ok.length < picked.length) toast(`跳过 ${picked.length - ok.length} 个不支持的文件`, { tone: 'waiting', body: `目前支持 ${ACCEPT.join(' / ')}` })
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    void add(e.dataTransfer.files)
  }
  return (
    <div className="kb-drop-wrap">
      <button
        type="button"
        className={`kb-drop pressable${over ? ' over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <FileUp aria-hidden />
        <span>
          <strong>拖入文件</strong>或点击选择
        </span>
        <span className="faint">{ACCEPT.join(' / ')}，可以一次拖入多个</span>
      </button>
      <input ref={input} type="file" multiple hidden accept={ACCEPT.map((x) => `.${x}`).join(',')} onChange={(e) => void add(e.target.files)} />
      {files.length > 0 && (
        <ul className="kb-files">
          {files.map((f) => (
            <li key={f.path} className="flash-row">
              <span className="mono truncate">{f.path}</span>
              <span className="faint num">{Math.max(1, Math.round(f.bytes / 1000))} KB</span>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`移除 ${f.path}`} onClick={() => onChange(files.filter((x) => x.path !== f.path))}>
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 字符串列表：回车添加、× 移除（表白名单、URL 列表、仓库）。 */
export function ListInput({ value, onChange, placeholder, mono, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; mono?: boolean; suggestions?: string[] }) {
  const [draft, setDraft] = useState('')
  const listId = useRef(`kb-dl-${Math.random().toString(36).slice(2)}`).current
  const add = () => {
    const parts = draft.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean)
    if (!parts.length) return
    onChange([...value, ...parts.filter((p) => !value.includes(p))])
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.preventDefault(), add())
    if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
  }
  return (
    <div className="kb-list-input">
      {value.map((v) => (
        <Chip key={v} onRemove={() => onChange(value.filter((x) => x !== v))}>
          <span className={mono ? 'mono' : undefined}>{v}</span>
        </Chip>
      ))}
      <input className={`kb-list-input-field${mono ? ' mono' : ''}`} value={draft} placeholder={value.length ? '' : placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} list={suggestions ? listId : undefined} />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.filter((s) => !value.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  )
}

/**
 * 密钥选择器：值是引用（secret:<name> 或 ${env:NAME}），页面拿不到明文。
 * 可以就地新建密钥：名字 + 值，只写不读（PUT /api/knowledge/secrets/:name）。
 */
export function SecretPicker({ value, onChange, id }: { value?: string; onChange: (v: string) => void; id?: string }) {
  const ds = useSource()
  const q = useAsync((d) => d.knowledgeSecrets(), [])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const names = q.data ?? []
  async function create() {
    setBusy(true)
    try {
      const r = await ds.putKnowledgeSecret(name.trim(), secret)
      onChange(`secret:${r.name}`)
      setCreating(false)
      setName('')
      setSecret('')
      q.reload()
      toast(`已保存密钥 ${r.name}`, { body: '只保存在服务端本机，页面不会再显示明文。' })
    } catch (e) {
      toast('保存密钥失败', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="kb-secret">
      <div className="kb-secret-row">
        <KeyRound className="kb-secret-icon" aria-hidden />
        <select id={id} className="select" value={value ?? ''} onChange={(e) => (e.target.value === '__new' ? setCreating(true) : onChange(e.target.value))}>
          <option value="">选择密钥</option>
          {names.map((n) => (
            <option key={n} value={`secret:${n}`}>
              {n}
            </option>
          ))}
          {value && !names.some((n) => `secret:${n}` === value) && <option value={value}>{value}</option>}
          <option value="__new">＋ 新建密钥</option>
        </select>
        {!creating && (
          <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
            <Plus />
            新建
          </button>
        )}
      </div>
      <div className="expand" data-open={creating}>
        <div inert={!creating}>
          <form className="kb-secret-new" onSubmit={(e) => (e.preventDefault(), void create())}>
            <input className="input mono" placeholder="名字，例如 orders-ro" value={name} onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ''))} aria-label="密钥名字" />
            <input className="input mono" type="password" autoComplete="new-password" placeholder="值（连接串、token）" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="密钥值" />
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !name.trim() || !secret}>
              保存
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCreating(false)}>
              取消
            </button>
          </form>
          <p className="kb-help">只写不读：保存后只能替换，不能查看。</p>
        </div>
      </div>
    </div>
  )
}
