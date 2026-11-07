import { useEffect, useState } from 'react'
import { BookOpen, Database, GitCommitHorizontal, Library, Network, Pencil, Plus, Search, Trash2, type LucideIcon } from 'lucide-react'
import type { KnowledgeKindInfo, SpaceConfigSettings, SpaceSettings } from '@taktflow/core'
import { useSource } from '../../api'
import { Dialog } from '../../components/ui/dialog'
import { ReasonDialog } from '../../components/ui/reason-dialog'
import { EmptyState, toast } from '../../components/ui'
import { Field, RevisionsButton, TagInput } from './settings-kit'

type Source = SpaceConfigSettings['knowledge'][number]

const ICONS: Record<string, LucideIcon> = { grep: Search, wiki: BookOpen, 'git-history': GitCommitHorizontal, workspace: Library, codegraph: Network, database: Database }
const ANSWERS: Record<string, string> = {
  grep: '某个符号、文案、配置在哪', wiki: '业务规则、规范、约定', 'git-history': '为什么这么写、以前怎么改的',
  workspace: '以前的需求怎么做的', codegraph: '谁调用了它、改了影响哪里', database: '表结构、字段含义',
}

/** 知识源：Agent 查资料的来源（takt.config.json 的 knowledge）。增删改都在这里，保存时写一句原因。 */
export function KnowledgeTab({ settings, onSaved }: { settings: SpaceSettings; onSaved: (next: SpaceSettings) => void }) {
  const ds = useSource()
  const list = settings.config.knowledge
  const [editing, setEditing] = useState<{ index: number; source?: Source }>()
  const [removing, setRemoving] = useState<number>()
  const kinds = settings.knowledgeKinds
  const label = (kind: string) => kinds.find((k) => k.kind === kind)?.label ?? kind
  const save = async (next: Source[], reason: string) => {
    const value = await ds.updateConfig({ knowledge: next }, reason)
    onSaved(value)
  }
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">知识源</span>
        <span className="faint num">{list.length}</span>
        <span className="spacer" />
        <RevisionsButton kind="config" label="修改记录" onRestored={() => void ds.settings().then(onSaved)} />
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({ index: -1 })}>
          <Plus />
          添加知识源
        </button>
      </div>
      {list.length === 0 ? (
        <EmptyState compact icon={BookOpen} title="使用默认知识源" hint="没配置时 Agent 按默认方式查资料（代码搜索、历史需求等）。添加后只用这里列出的来源，例如把团队的文档目录加进来。" />
      ) : (
        <ul className="knowledge-list">
          {list.map((k, i) => {
            const Icon = ICONS[k.kind] ?? Library
            const options = Object.entries(k.options ?? {})
            return (
              <li key={k.id} className="knowledge-row">
                <span className="knowledge-icon" aria-hidden><Icon /></span>
                <div className="knowledge-main">
                  <div className="knowledge-title">
                    <span className="mono knowledge-id">{k.id}</span>
                    <span className="chip chip-sm">{label(k.kind)}</span>
                  </div>
                  <p className="knowledge-desc">
                    {options.length ? options.map(([key, v]) => <span key={key} className="mono">{key}: {Array.isArray(v) ? v.join(', ') : String(v)}　</span>) : <span className="faint">默认选项</span>}
                  </p>
                </div>
                <span className="knowledge-answers">
                  <span className="field-label">回答</span>
                  {ANSWERS[k.kind] ?? '由插件声明'}
                </span>
                <span className="sk-row">
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`编辑 ${k.id}`} onClick={() => setEditing({ index: i, source: k })}><Pencil /></button>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`删除 ${k.id}`} onClick={() => setRemoving(i)}><Trash2 /></button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <SourceDialog
        open={!!editing}
        source={editing?.source}
        kinds={kinds}
        taken={list.filter((_, i) => i !== editing?.index).map((k) => k.id)}
        onClose={() => setEditing(undefined)}
        onSubmit={async (source, reason) => {
          const next = editing!.index < 0 ? [...list, source] : list.map((k, i) => (i === editing!.index ? source : k))
          await save(next, reason)
          toast(editing!.index < 0 ? `已添加知识源 ${source.id}` : `已更新知识源 ${source.id}`)
          setEditing(undefined)
        }}
      />
      <ReasonDialog
        open={removing !== undefined}
        onClose={() => setRemoving(undefined)}
        title={removing !== undefined ? `删除知识源 ${list[removing]?.id}？` : ''}
        description="之后启动的运行不再查这个来源；修改记录里可以恢复。"
        risk="dangerous"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await save(list.filter((_, i) => i !== removing), reason)
          toast('已删除知识源')
        }}
      />
    </div>
  )
}

function SourceDialog({ open, source, kinds, taken, onClose, onSubmit }: {
  open: boolean
  source?: Source
  kinds: KnowledgeKindInfo[]
  taken: string[]
  onClose: () => void
  onSubmit: (source: Source, reason: string) => Promise<void>
}) {
  const [kind, setKind] = useState('wiki')
  const [id, setId] = useState('')
  const [options, setOptions] = useState<Record<string, string | string[]>>({})
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setKind(source?.kind ?? 'wiki'); setId(source?.id ?? ''); setReason(''); setError(undefined)
    setOptions(Object.fromEntries(Object.entries(source?.options ?? {}).map(([k, v]) => [k, Array.isArray(v) ? (v as string[]) : String(v)])))
  }, [open, source])
  const info = kinds.find((k) => k.kind === kind)
  const idOk = /^[A-Za-z0-9][\w-]*$/.test(id) && !taken.includes(id)
  const valid = idOk && reason.trim()
  const submit = async () => {
    if (!valid || busy) return
    setBusy(true); setError(undefined)
    const opts = Object.fromEntries(Object.entries(options).filter(([k, v]) => info?.options.some((o) => o.key === k) && (Array.isArray(v) ? v.length : v.trim())))
    try { await onSubmit({ id, kind, ...(Object.keys(opts).length ? { options: opts } : {}) }, reason.trim()) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={onClose} title={source ? `编辑知识源 ${source.id}` : '添加知识源'} size="md" dismissible={!reason}
      footer={<>
        {error && <span className="ov-error">{error}</span>}
        <button type="button" className="btn btn-sm" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? '保存中…' : '保存'}</button>
      </>}>
      <div className="sk-section-body" style={{ gridTemplateColumns: '1fr' }}>
        <div className="sk-field">
          <span className="field-label">类型</span>
          <div className="sk-choice">
            {kinds.map((k) => (
              <button key={k.kind} type="button" className={`sk-choice-item${k.kind === kind ? ' on' : ''}`} onClick={() => { setKind(k.kind); setOptions({}) }} aria-pressed={k.kind === kind}>
                <span className="sk-choice-title">{k.label}</span>
                <span className="sk-choice-desc">{k.description}</span>
              </button>
            ))}
          </div>
        </div>
        <Field label="名称" hint={id && !idOk ? (taken.includes(id) ? '名称已被占用' : '只能用字母、数字、下划线和连字符') : '查询记录里用它标识来源，例如 team-wiki。'}>
          <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="team-wiki" />
        </Field>
        {info?.options.map((o) => (
          <Field key={o.key} label={o.label} hint="空间内的相对路径。">
            {o.type === 'paths' ? (
              <TagInput value={(options[o.key] as string[] | undefined) ?? []} onChange={(v) => setOptions({ ...options, [o.key]: v })} placeholder={o.placeholder} mono ariaLabel={o.label} />
            ) : (
              <input className="input mono" value={(options[o.key] as string | undefined) ?? ''} onChange={(e) => setOptions({ ...options, [o.key]: e.target.value })} placeholder={o.placeholder} />
            )}
          </Field>
        ))}
        <Field label="原因">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：让 PM 查业务规则文档" onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
        </Field>
      </div>
    </Dialog>
  )
}
