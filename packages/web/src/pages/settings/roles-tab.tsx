import { useEffect, useMemo, useState } from 'react'
import { Copy, Plus, Trash2, UserRoundCog } from 'lucide-react'
import type { RoleSaveRequest, SpaceRoleSettings, SpaceSettings } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { Dialog } from '../../components/ui/dialog'
import { ReasonDialog } from '../../components/ui/reason-dialog'
import { EmptyState, toast } from '../../components/ui'
import { useDraftForm, useUnsavedWarning } from '../../lib/draft'
import { setQuery, useLocation } from '../../lib/router'
import { FileEditor } from './files-tab'
import { Field, RevisionsButton, SaveBar, Section, TagInput } from './settings-kit'

const WRITE_PRESETS = [
  { label: '产品代码', values: ['src/**'] },
  { label: '测试代码', values: ['test/**'] },
  { label: '依赖清单', values: ['package.json'] },
  { label: '需求产物', values: ['requirements/**', '.takt/workspaces/**'] },
]
const READ_PRESETS = [
  { label: '需求产物', values: ['requirements/**', '.takt/workspaces/**'] },
  { label: '知识库', values: ['knowledge/**', 'docs/**'] },
  { label: '测试代码', values: ['test/**'] },
]

interface Form {
  title: string
  description: string
  skills: string[]
  writeScope: string[]
  limitRead: boolean
  readScope: string[]
  model: string
  instructions: string
}

const toForm = (r: SpaceRoleSettings): Form => ({
  title: r.title, description: r.description, skills: r.skills, writeScope: r.writeScope,
  limitRead: r.readScope !== undefined, readScope: r.readScope ?? [], model: r.harness.model ?? '', instructions: r.instructions,
})

function toBody(f: Form, o: Form, hash: string, reason: string): RoleSaveRequest {
  const profile: RoleSaveRequest['profile'] = {}
  if (f.title !== o.title) profile.title = f.title
  if (f.description !== o.description) profile.description = f.description
  if (JSON.stringify(f.skills) !== JSON.stringify(o.skills)) profile.skills = f.skills
  if (JSON.stringify(f.writeScope) !== JSON.stringify(o.writeScope)) profile.writeScope = f.writeScope
  if (f.limitRead !== o.limitRead || JSON.stringify(f.readScope) !== JSON.stringify(o.readScope)) profile.readScope = f.limitRead ? f.readScope : null
  if (f.model !== o.model) profile.model = f.model || null
  return { profile, ...(f.instructions !== o.instructions ? { instructions: f.instructions } : {}), baseHash: hash, reason }
}

/** 角色：每个流程节点由哪个角色来做——说明、能用哪些技能、能读写哪些文件、用什么模型。 */
export function RolesTab({ settings, onChanged }: { settings: SpaceSettings; onChanged: () => void }) {
  const { query } = useLocation()
  const [creating, setCreating] = useState(false)
  const roles = settings.roles
  const selected = roles.find((r) => r.role === query.get('name')) ?? roles[0]
  return (
    <div className="sk-split">
      <aside className="card sk-list-card" aria-label="角色列表">
        <div className="sk-list-head">
          <span className="card-title">角色</span>
          <span className="faint num">{roles.length}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
            <Plus />
            新建
          </button>
        </div>
        <ul className="sk-list">
          {roles.map((r) => (
            <li key={r.role}>
              <button type="button" className={`file-item${r.role === selected?.role ? ' on' : ''}`} onClick={() => setQuery({ name: r.role })} aria-current={r.role === selected?.role ? 'true' : undefined}>
                <span className="file-item-title">
                  {r.title}
                  <span className="faint mono">{r.role}</span>
                </span>
                <span className="file-item-desc">{r.description || '（没有说明）'}</span>
                <span className="sk-item-chips">
                  {r.writeScope.length === 0 ? <span className="chip">只读</span> : <span className="chip">可写</span>}
                  {r.readScope && <span className="chip">读范围受限</span>}
                  {r.skills.length > 0 && <span className="chip">{r.skills.length} 个技能</span>}
                  {r.usedBy.length > 0 && <span className="chip">{r.usedBy.length} 个节点在用</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {selected ? (
        <RoleForm key={selected.role} role={selected} settings={settings} onChanged={onChanged} onCopy={() => setCreating(true)} />
      ) : (
        <div className="card">
          <EmptyState icon={UserRoundCog} title="还没有角色" hint="角色决定流程节点由谁来做。新建一个，或在 Workflow 页从模板新建流程时自动补齐默认角色。" action={<button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Plus />新建角色</button>} />
        </div>
      )}
      <NewRoleDialog open={creating} onClose={() => setCreating(false)} settings={settings} copyFrom={selected?.role} onCreated={(role) => { setCreating(false); onChanged(); setQuery({ name: role }) }} />
    </div>
  )
}

function RoleForm({ role, settings, onChanged, onCopy }: { role: SpaceRoleSettings; settings: SpaceSettings; onChanged: () => void; onCopy: () => void }) {
  const ds = useSource()
  const original = useMemo(() => toForm(role), [role])
  const { form, setForm, dirty, reset, markSaved } = useDraftForm(`role:${role.role}`, original, role.hash)
  useUnsavedWarning(dirty)
  const [deleting, setDeleting] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))
  const hostRuns = ds.host?.manageRuntime === false
  const models = useAsync((d) => d.host?.models?.() ?? Promise.resolve(undefined), [])
  const readOnly = form.writeScope.length === 0

  const save = async (reason: string) => {
    const submitted = form
    try {
      await ds.saveRole(role.role, toBody(form, original, role.hash, reason))
      markSaved(submitted)
      toast(`已保存 ${submitted.title}`, { body: '之后启动的运行按新档案组装这个角色。' })
      onChanged()
    } catch (e) {
      toast('保存失败', { body: (e as Error).message, tone: 'failed' })
    }
  }

  return (
    <div className="card sk-form-card">
      <header className="sk-form-head">
        <h3 className="sk-form-title">{role.title}</h3>
        <span className="faint mono">{role.file}</span>
        <span className="spacer" />
        <RevisionsButton kind="agent" name={role.role} onRestored={onChanged} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy} title="以这个角色为模板新建">
          <Copy />
          复制
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeleting(true)} disabled={role.role === 'lead'} title={role.role === 'lead' ? 'Lead 由宿主使用，不能删除' : undefined}>
          <Trash2 />
          删除
        </button>
      </header>

      <Section title="基本信息">
        <Field label="名称">
          <input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="一句话说明" hint="Lead 派活、评审分配时会看到。">
          <input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="模型" hint={hostRuns ? '默认跟随 App 当前选择的模型。' : `执行器：${role.harness.harness}`}>
          {models.data && models.data.length > 0 ? (
            <select className="select" value={form.model} onChange={(e) => set('model', e.target.value)}>
              <option value="">跟随 App</option>
              {models.data.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {form.model && !models.data.some((m) => m.id === form.model) && <option value={form.model}>{form.model}（未在 App 中配置）</option>}
            </select>
          ) : hostRuns ? (
            <input className="input" value="跟随 App" disabled />
          ) : (
            <input className="input mono" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="默认" />
          )}
        </Field>
        <Field label="被使用" hint="按流程源码统计。被使用的角色不能删除。" wide>
          <span className="sk-usage">
            {role.usedBy.length === 0 ? <span className="faint">没有流程节点使用</span> : role.usedBy.map((u) => <span key={`${u.workflow}/${u.node}`} className="chip mono">{u.workflow} · {u.node}</span>)}
          </span>
        </Field>
      </Section>

      <Section title="能力" hint="技能只注入这个角色的子 Agent；读写范围由宿主强制执行，越界会被拦下并记在子 Agent 追溯里。">
        <Field label="技能" wide hint={settings.skills.length === 0 ? '空间里还没有技能，先到“技能”页新建。' : '点选挂到这个角色上的技能。'}>
          <span className="sk-usage">
            {settings.skills.map((s) => {
              const on = form.skills.includes(s.name)
              return (
                <button key={s.name} type="button" className={`chip sk-pick${on ? ' on' : ''}`} aria-pressed={on} title={s.description}
                  onClick={() => set('skills', on ? form.skills.filter((x) => x !== s.name) : [...form.skills, s.name])}>
                  {on ? '✓ ' : ''}{s.name}
                </button>
              )
            })}
          </span>
        </Field>
        <Field label={`可写范围${readOnly ? '（只读角色）' : ''}`} wide hint="空着就是只读角色：评审、分析类角色通常只读。开发、自动化角色可写时会拿到受控自测工具。">
          <TagInput value={form.writeScope} onChange={(v) => set('writeScope', v)} placeholder="例如 src/**，回车添加" presets={WRITE_PRESETS} mono ariaLabel="可写范围" />
        </Field>
        <div className="sk-field wide">
          <label className="sk-row">
            <input type="checkbox" checked={form.limitRead} onChange={(e) => set('limitRead', e.target.checked)} />
            <span className="field-label">限制可读范围</span>
          </label>
          <span className="sk-field-hint">例如测试设计只看需求和契约、看不到产品代码，避免“照着实现写用例”。不限制时可读整个空间。</span>
          {form.limitRead && <TagInput value={form.readScope} onChange={(v) => set('readScope', v)} placeholder="例如 requirements/**，回车添加" presets={READ_PRESETS} mono ariaLabel="可读范围" />}
        </div>
      </Section>

      <Section title="职责说明" hint="这个角色的系统提示：做什么、怎么做、不能做什么。支持 Markdown。">
        <textarea className="textarea sk-instructions sk-field wide" value={form.instructions} onChange={(e) => set('instructions', e.target.value)} spellCheck={false} aria-label="职责说明" />
      </Section>

      <details className="sk-advanced">
        <summary>高级 · 查看源文件</summary>
        <FileEditor kind="agent" name={role.role} onSaved={onChanged} />
      </details>

      <SaveBar dirty={dirty} onSave={save} onReset={reset} />

      <ReasonDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`删除角色 ${role.title}？`}
        description={role.usedBy.length ? `还有 ${role.usedBy.length} 个流程节点在用它，删除会被拒绝；先在 Workflow 里换掉。` : '文件会删除；修改记录里保留删除前的版本，可以恢复。'}
        risk="dangerous"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await ds.deleteRole(role.role, reason)
          toast(`已删除 ${role.title}`)
          setQuery({ name: undefined })
          onChanged()
        }}
      />
    </div>
  )
}

function NewRoleDialog({ open, onClose, settings, copyFrom, onCreated }: { open: boolean; onClose: () => void; settings: SpaceSettings; copyFrom?: string; onCreated: (role: string) => void }) {
  const ds = useSource()
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [from, setFrom] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setId(''); setTitle(''); setFrom(copyFrom ?? ''); setReason(''); setError(undefined) } }, [open, copyFrom])
  const valid = /^[a-z][a-z0-9-]{0,47}$/.test(id) && title.trim() && reason.trim()
  const submit = async () => {
    if (!valid || busy) return
    setBusy(true); setError(undefined)
    try {
      await ds.saveRole(id, { create: true, ...(from ? { copyFrom: from } : {}), profile: { title: title.trim() }, reason: reason.trim() })
      toast(`已新建角色 ${title.trim()}`)
      onCreated(id)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={onClose} title="新建角色" description="新角色可以从现有角色复制（技能、读写范围、职责说明一并沿用），再按需修改。" size="sm" dismissible={!id && !title}
      footer={<>
        {error && <span className="ov-error">{error}</span>}
        <button type="button" className="btn btn-sm" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? '新建中…' : '新建'}</button>
      </>}>
      <div className="sk-section-body" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="角色 id" hint="小写字母、数字和连字符，流程节点里用它引用，例如 security-reviewer。">
          <input className="input mono" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="security-reviewer" data-autofocus />
        </Field>
        <Field label="名称">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="安全评审" />
        </Field>
        <Field label="从哪个角色复制">
          <select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">不复制（空白角色）</option>
            {settings.roles.map((r) => <option key={r.role} value={r.role}>{r.title}（{r.role}）</option>)}
          </select>
        </Field>
        <Field label="原因">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：上线前需要独立的安全评审" onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
        </Field>
      </div>
    </Dialog>
  )
}
