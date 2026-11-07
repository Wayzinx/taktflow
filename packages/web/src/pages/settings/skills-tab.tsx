import { useEffect, useMemo, useState } from 'react'
import { Plus, Sparkles, Trash2 } from 'lucide-react'
import type { SpaceSettings, SpaceSkillSettings } from '@taktflow/core'
import { useSource } from '../../api'
import { Dialog } from '../../components/ui/dialog'
import { ReasonDialog } from '../../components/ui/reason-dialog'
import { EmptyState, toast } from '../../components/ui'
import { setQuery, useLocation } from '../../lib/router'
import { Field, RevisionsButton, SaveBar, Section } from './settings-kit'

/** 技能：团队沉淀的做事方法（SKILL.md）；挂到角色上后只注入那个角色的子 Agent。 */
export function SkillsTab({ settings, onChanged }: { settings: SpaceSettings; onChanged: () => void }) {
  const { query } = useLocation()
  const [creating, setCreating] = useState(false)
  const skills = settings.skills
  const selected = skills.find((s) => s.name === query.get('name')) ?? skills[0]
  const create = <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Plus />新建技能</button>
  return (
    <>
      {skills.length === 0 ? (
        <div className="card">
          <EmptyState icon={Sparkles} title="还没有技能" hint="技能是团队沉淀的做事方法，例如“金额格式约定”“接口契约评审清单”。新建后在“角色”页挂到需要的角色上。" action={create} />
        </div>
      ) : (
        <div className="sk-split">
          <aside className="card sk-list-card" aria-label="技能列表">
            <div className="sk-list-head">
              <span className="card-title">技能</span>
              <span className="faint num">{skills.length}</span>
              <span className="spacer" />
              <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}><Plus />新建</button>
            </div>
            <ul className="sk-list">
              {skills.map((s) => (
                <li key={s.name}>
                  <button type="button" className={`file-item${s.name === selected?.name ? ' on' : ''}`} onClick={() => setQuery({ name: s.name })} aria-current={s.name === selected?.name ? 'true' : undefined}>
                    <span className="file-item-title mono">{s.name}</span>
                    <span className="file-item-desc">{s.description}</span>
                    <span className="sk-item-chips">
                      {s.usedBy.length ? s.usedBy.map((r) => <span key={r} className="chip">{r}</span>) : <span className="chip">没有角色在用</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          {selected && <SkillForm key={`${selected.name}:${selected.hash}`} skill={selected} onChanged={onChanged} />}
        </div>
      )}
      <NewSkillDialog open={creating} onClose={() => setCreating(false)} onCreated={(name) => { setCreating(false); onChanged(); setQuery({ name }) }} />
    </>
  )
}

function SkillForm({ skill, onChanged }: { skill: SpaceSkillSettings; onChanged: () => void }) {
  const ds = useSource()
  const original = useMemo(() => ({ description: skill.description, body: skill.body }), [skill])
  const [form, setForm] = useState(original)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => setForm(original), [original])
  const dirty = form.description !== original.description || form.body !== original.body
  const save = async (reason: string) => {
    try {
      await ds.saveSkill(skill.name, { description: form.description, body: form.body, baseHash: skill.hash, reason })
      toast(`已保存技能 ${skill.name}`, { body: '运行前会同步到用它的角色。' })
      onChanged()
    } catch (e) {
      toast('保存失败', { body: (e as Error).message, tone: 'failed' })
    }
  }
  return (
    <div className="card sk-form-card">
      <header className="sk-form-head">
        <h3 className="sk-form-title mono">{skill.name}</h3>
        <span className="faint mono">{skill.file}</span>
        <span className="spacer" />
        <RevisionsButton kind="skill" name={skill.name} onRestored={onChanged} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeleting(true)}><Trash2 />删除</button>
      </header>
      <Section title="说明">
        <Field label="什么时候用" hint="Agent 根据这句话判断要不要读这个技能，写清适用场景。" wide>
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="使用的角色" wide>
          <span className="sk-usage">{skill.usedBy.length ? skill.usedBy.map((r) => <span key={r} className="chip mono">{r}</span>) : <span className="faint">还没有角色挂这个技能，到“角色”页添加。</span>}</span>
        </Field>
      </Section>
      <Section title="正文" hint="具体做法、约定、正反例。支持 Markdown。">
        <textarea className="textarea sk-instructions sk-field wide" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} spellCheck={false} aria-label="技能正文" />
      </Section>
      <SaveBar dirty={dirty} onSave={save} onReset={() => setForm(original)} />
      <ReasonDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`删除技能 ${skill.name}？`}
        description={skill.usedBy.length ? `还有角色在用（${skill.usedBy.join('、')}），删除会被拒绝；先在角色里取下。` : '修改记录里保留删除前的版本，可以恢复。'}
        risk="dangerous"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await ds.deleteSkill(skill.name, reason)
          toast(`已删除技能 ${skill.name}`)
          setQuery({ name: undefined })
          onChanged()
        }}
      />
    </div>
  )
}

function NewSkillDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const ds = useSource()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(''); setDescription(''); setBody(''); setReason(''); setError(undefined) } }, [open])
  const valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && description.trim() && reason.trim()
  const submit = async () => {
    if (!valid || busy) return
    setBusy(true); setError(undefined)
    try {
      await ds.saveSkill(name, { create: true, description: description.trim(), body, reason: reason.trim() })
      toast(`已新建技能 ${name}`, { body: '到“角色”页把它挂到需要的角色上。' })
      onCreated(name)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={onClose} title="新建技能" size="md" dismissible={!name && !description && !body}
      footer={<>
        {error && <span className="ov-error">{error}</span>}
        <button type="button" className="btn btn-sm" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? '新建中…' : '新建'}</button>
      </>}>
      <div className="sk-section-body" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="名称" hint="小写字母、数字和连字符，例如 money-format。">
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="money-format" data-autofocus />
        </Field>
        <Field label="什么时候用">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="金额字段的格式化与舍入规则" />
        </Field>
        <Field label="正文（可以之后再写）">
          <textarea className="textarea sk-instructions" value={body} onChange={(e) => setBody(e.target.value)} placeholder={'# 金额格式\n\n- 统一两位小数……'} />
        </Field>
        <Field label="原因">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：财务对账要求统一舍入" />
        </Field>
      </div>
    </Dialog>
  )
}
