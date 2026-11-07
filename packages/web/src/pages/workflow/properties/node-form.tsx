import type { EditableNode, EditableValue, EditableWorkflow, HarnessSelector, VerdictCategory, WorkflowEdit } from '@taktflow/core'
import { findNode, lit, literalOf, needsOf } from '../../../api/workflow-edit'
import { ARTIFACT_KIND, ARTIFACT_KIND_ORDER } from '../../../lib/status'
import { canConnect, stagesOf } from '../canvas/graph'
import { CodeValue } from './code-value'
import { Field, JsonEditor, ListEditor, LongText, NumberInput, Select, TextInput, Toggle } from './fields'
import type { Option } from './options'
import { fieldsOf, HIDDEN_KEYS, type FieldSpec } from './schema'
import { ChecklistEditor } from './checklist'
import { ArbiterField, DutySelect, type ArbiterValue } from './owner-fields'
import { ExhaustedField, NeedsField, PassField, RoutesField, siblingOptions, TargetField } from './special-fields'
import { useSource } from '../../../api'

export interface FormCtx {
  model: EditableWorkflow
  node: EditableNode
  disabled: boolean
  roles: Option[]
  harnesses: Option[]
  /** 负责人下拉的职责标签（空间成员 duties）。 */
  duties?: Option[]
  apply(edits: WorkflowEdit[], reason: string): void
}

const OUTPUT_KINDS: Option[] = ARTIFACT_KIND_ORDER.map((k) => ({ value: k, label: `${k} · ${ARTIFACT_KIND[k]}` }))

function literalField(f: FieldSpec, v: unknown, fid: string, ctx: FormCtx, set: (value: unknown) => void) {
  const { model, node, disabled } = ctx
  const loc = findNode(model.nodes, node.id)!
  const siblings = siblingOptions(loc.list, node.id)
  switch (f.type) {
    case 'string':
    case 'mono':
      return <TextInput id={fid} mono={f.type === 'mono'} value={typeof v === 'string' ? v : ''} disabled={disabled} onCommit={(s) => set(s || (f.optional ? undefined : ''))} />
    case 'text':
    case 'script':
      return <LongText id={fid} mono={f.type === 'script'} rows={f.type === 'script' ? 2 : 6} value={typeof v === 'string' ? v : ''} disabled={disabled} onCommit={(s) => set(s || (f.optional ? undefined : ''))} />
    case 'number':
      return <NumberInput id={fid} value={typeof v === 'number' ? v : undefined} min={f.min} max={f.max} disabled={disabled} onCommit={set} />
    case 'bool':
      return <Toggle id={fid} label={v ? '是' : '否'} value={v === true} disabled={disabled} onCommit={(b) => set(b || undefined)} />
    case 'enum':
      return <Select id={fid} value={v as string | undefined} options={f.options ?? []} empty={f.optional ? '默认' : undefined} disabled={disabled} onCommit={set} />
    case 'role':
      return <Select id={fid} value={v as string | undefined} options={ctx.roles} empty="选择角色" disabled={disabled} onCommit={set} />
    case 'stage':
      return <Select id={fid} value={v as string | undefined} options={stagesOf(model).map((s) => ({ value: s.id, label: s.title }))} empty="不分阶段" disabled={disabled} onCommit={set} />
    case 'node':
      return <Select id={fid} value={v as string | undefined} options={siblings} empty="选择节点" disabled={disabled} onCommit={(s) => set(s ?? '')} />
    case 'harness': {
      const cur = v as HarnessSelector | undefined
      return <Select id={fid} value={cur?.harness} options={ctx.harnesses} empty="角色默认" disabled={disabled} onCommit={(h) => set(h ? { ...cur, harness: h } : undefined)} />
    }
    case 'strings':
    case 'roles':
      return <ListEditor id={fid} value={Array.isArray(v) ? v : []} disabled={disabled} placeholder={f.type === 'roles' ? 'dev' : 'src/**'} onCommit={(a) => set(a.length || !f.optional ? a : undefined)} />
    case 'paths':
      return <ListEditor id={fid} value={Array.isArray(v) ? v : []} columns={[{ key: 'path', label: '路径', mono: true }]} disabled={disabled} addLabel="添加输入" onCommit={(a) => set(a.length ? a : undefined)} />
    case 'outputs':
      return <ListEditor id={fid} value={Array.isArray(v) ? v : []} columns={[{ key: 'path', label: '路径', mono: true }, { key: 'kind', label: '类型', options: OUTPUT_KINDS }]} disabled={disabled} addLabel="添加产出" onCommit={(a) => set(a.length ? a : undefined)} />
    case 'reviewers':
      return <ListEditor id={fid} value={Array.isArray(v) ? v : []} columns={[{ key: 'role', label: '角色', options: ctx.roles }, { key: 'focus', label: '侧重点' }]} disabled={disabled} addLabel="添加评审者" onCommit={set} />
    case 'author': {
      const a = (v ?? {}) as { role?: string; prompt?: string }
      return <Select id={fid} value={a.role} options={ctx.roles} empty="选择角色" disabled={disabled} onCommit={(role) => set({ ...a, role: role ?? '' })} />
    }
    case 'pass':
      return <PassField id={fid} value={v as never} disabled={disabled} onCommit={set} />
    case 'exhausted':
      return <ExhaustedField id={fid} value={v as never} nodes={siblings} disabled={disabled} onCommit={set} />
    case 'routes':
      return <RoutesField id={fid} value={(v ?? {}) as Partial<Record<VerdictCategory, string>>} nodes={siblings} disabled={disabled} onCommit={set} />
    case 'target':
      return <TargetField id={fid} value={v as never} disabled={disabled} onCommit={set} />
    case 'duty':
      return <DutySelect id={fid} value={v as string | undefined} options={ctx.duties ?? []} disabled={disabled} onCommit={set} />
    case 'checklist':
      return <ChecklistEditor id={fid} value={Array.isArray(v) ? v.map(String) : []} disabled={disabled} onCommit={(a) => set(a.length ? a : undefined)} />
    case 'arbiter':
      return <ArbiterField id={fid} value={v as ArbiterValue | undefined} roles={ctx.roles} disabled={disabled} onCommit={set} />
    case 'json':
    case 'needs':
      return <JsonEditor id={fid} value={v} disabled={disabled} onCommit={set} />
  }
}

function FieldRow({ f, ctx }: { f: FieldSpec; ctx: FormCtx }) {
  const host = useSource().host
  const { node, model, disabled, apply } = ctx
  // 不管理成员的宿主（dsh 本机只有一个用户）不显示“负责人”职责派发。
  if (f.type === 'duty' && host?.manageMembers === false) return null
  const fid = `wf-prop-${node.id}-${f.key}`
  const value = node.props[f.key]
  const commit = (next: EditableValue | null) => apply([{ op: 'setProp', id: node.id, key: f.key, value: next }], `修改 ${node.id}.${f.key}`)
  if (f.type === 'needs') {
    const needs = needsOf(node)
    const loc = findNode(model.nodes, node.id)!
    const candidates = siblingOptions(loc.list, node.id).filter((o) => !canConnect(model, o.value, node.id))
    return (
      <Field label={f.label} hint={f.hint} htmlFor={fid}>
        <NeedsField id={fid} needs={needs} candidates={candidates} disabled={disabled} onCommit={(n) => apply([{ op: 'setNeeds', id: node.id, needs: n }], `修改 ${node.id} 的依赖`)} />
      </Field>
    )
  }
  if (value?.kind === 'code')
    return (
      <Field label={f.label} htmlFor={fid}>
        <CodeValue id={fid} code={value.code} disabled={disabled} onCommit={(c) => commit({ kind: 'code', code: c })} />
      </Field>
    )
  // 必填项清空时不提交（保持原值），可选项清空即删除该键
  const set = (v: unknown) => (v === undefined ? f.optional && commit(null) : commit(lit(v)))
  return (
    <Field label={f.label} hint={f.hint} htmlFor={fid}>
      {literalField(f, literalOf(value), fid, ctx, set)}
    </Field>
  )
}

/** 节点属性表单：已有的和必填的属性直接列出，可选且未设置的收进"更多属性"；schema 外的键按原样（JSON / 代码）编辑。 */
export function NodeForm({ ctx }: { ctx: FormCtx }) {
  const { node } = ctx
  const inLoop = !!findNode(ctx.model.nodes, node.id)?.parent
  const specs = fieldsOf(node.kind, inLoop)
  const known = new Set(specs.map((f) => f.key))
  const extra: FieldSpec[] = Object.keys(node.props).filter((k) => !known.has(k) && !HIDDEN_KEYS.has(k)).map((k) => ({ key: k, label: k, type: 'json', optional: true }))
  const shown = [...specs.filter((f) => !f.optional || f.always || node.props[f.key] || f.type === 'needs'), ...extra]
  const more = specs.filter((f) => f.optional && !f.always && !node.props[f.key] && f.type !== 'needs')
  return (
    <div className="wf-form">
      {shown.map((f) => <FieldRow key={f.key} f={f} ctx={ctx} />)}
      {more.length > 0 && !ctx.disabled && (
        <details className="wf-more">
          <summary>更多属性（{more.length}）</summary>
          {more.map((f) => <FieldRow key={f.key} f={f} ctx={ctx} />)}
        </details>
      )}
    </div>
  )
}
