import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { EditableWorkflow, WorkflowEdit } from '@taktflow/core'
import { literalOf } from '../../../api/workflow-edit'
import { stagesOf, type Stage } from '../canvas/graph'
import { CodeValue } from './code-value'
import { Field, LongText, TextInput, useDraft } from './fields'

/** 未选节点时：workflow 元信息（setMeta）与阶段列表（setStages）。阶段 id 被节点引用时不能删除。 */
export function MetaForm({ model, disabled, apply }: { model: EditableWorkflow; disabled: boolean; apply(edits: WorkflowEdit[], reason: string): void }) {
  const meta = (key: 'title' | 'description' | 'version', label: string, long?: boolean) => {
    const v = model.meta[key]
    const fid = `wf-meta-${key}`
    if (v?.kind === 'code') return <Field label={label} htmlFor={fid}><CodeValue id={fid} code={v.code} disabled /></Field>
    const commit = (value: string) => apply([{ op: 'setMeta', key, value }], `修改 ${key}`)
    return (
      <Field label={label} htmlFor={fid}>
        {long ? <LongText id={fid} rows={3} value={literalOf<string>(v) ?? ''} disabled={disabled} onCommit={commit} /> : <TextInput id={fid} mono={key === 'version'} value={literalOf<string>(v) ?? ''} disabled={disabled} onCommit={commit} />}
      </Field>
    )
  }
  return (
    <div className="wf-form">
      {meta('title', '标题')}
      {meta('description', '说明', true)}
      {meta('version', '版本')}
      <Field label="阶段" hint={model.stages.kind === 'code' ? '阶段由代码生成，画布不能编辑' : '每个阶段是画布上的一条泳道；被节点使用的阶段不能删除'}>
        {model.stages.kind === 'code' ? <CodeValue id="wf-meta-stages" code={model.stages.code} disabled /> : <StagesEditor model={model} disabled={disabled} apply={apply} />}
      </Field>
    </div>
  )
}

function StagesEditor({ model, disabled, apply }: { model: EditableWorkflow; disabled: boolean; apply(edits: WorkflowEdit[], reason: string): void }) {
  const stages = stagesOf(model)
  const [d, set, dirty] = useDraft(stages)
  const used = new Set(model.nodes.map((n) => literalOf<string>(n.props.stage)).filter(Boolean))
  const commit = (next: Stage[], reason = '修改阶段') => {
    const clean = next.filter((s) => s.id.trim()).map((s) => ({ id: s.id.trim(), title: s.title.trim() || s.id.trim() }))
    if (new Set(clean.map((s) => s.id)).size !== clean.length) return set(stages)
    // 改了被使用的阶段 id 会让节点悬空：只允许改标题
    if (stages.some((s) => used.has(s.id) && !clean.some((c) => c.id === s.id))) return set(stages)
    if (JSON.stringify(clean) !== JSON.stringify(stages)) apply([{ op: 'setStages', stages: clean }], reason)
  }
  const patch = (i: number, p: Partial<Stage>) => set(d.map((s, j) => (j === i ? { ...s, ...p } : s)))
  const move = (i: number, dir: -1 | 1) => {
    const next = [...d]
    ;[next[i], next[i + dir]] = [next[i + dir]!, next[i]!]
    commit(next, '调整阶段顺序')
  }
  return (
    <div className="wf-list">
      {d.map((s, i) => (
        <div className="wf-list-row wf-stage-row" key={i}>
          <span className="mono num faint">{String(i + 1).padStart(2, '0')}</span>
          <input className="input mono" value={s.id} disabled={disabled || used.has(stages[i]?.id ?? '')} aria-label={`第 ${i + 1} 个阶段 id`} onChange={(e) => patch(i, { id: e.target.value })} onBlur={() => dirty && commit(d)} />
          <input className="input" value={s.title} disabled={disabled} aria-label={`第 ${i + 1} 个阶段标题`} onChange={(e) => patch(i, { title: e.target.value })} onBlur={() => dirty && commit(d)} />
          {!disabled && (
            <span className="wf-row-tools">
              <button className="btn btn-ghost btn-sm btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移"><ArrowUp /></button>
              <button className="btn btn-ghost btn-sm btn-icon" disabled={i === d.length - 1} onClick={() => move(i, 1)} aria-label="下移"><ArrowDown /></button>
              <button className="btn btn-ghost btn-sm btn-icon" disabled={used.has(s.id)} title={used.has(s.id) ? '有节点在这个阶段' : undefined} onClick={() => commit(d.filter((_, j) => j !== i), `删除阶段 ${s.id}`)} aria-label="删除阶段"><Trash2 /></button>
            </span>
          )}
        </div>
      ))}
      {!disabled && (
        <button className="btn btn-sm wf-add-row" onClick={() => set([...d, { id: `stage-${d.length + 1}`, title: '新阶段' }])}>
          <Plus />
          添加阶段
        </button>
      )}
    </div>
  )
}
