import type { EditableValue, EditableWorkflow, RunBudget, Tier, WorkflowEdit } from '@taktflow/core'
import { lit, literalOf } from '../../../api/workflow-edit'
import { TIER_LABEL, TierGlyph } from '../../../components/tier-glyph'
import { CodeValue } from './code-value'
import { Field, LongText, NumberInput } from './fields'

type MetaKey = 'useWhen' | 'tiers' | 'leadInstructions' | 'dynamicRules' | 'budget'
type Apply = (edits: WorkflowEdit[], reason: string) => void

const TIERS: Tier[] = ['T0', 'T1', 'T2', 'T3']

const BUDGET_FIELDS: Array<{ key: keyof RunBudget; label: string; unit: string; min: number }> = [
  { key: 'tokens', label: 'Token', unit: 'tok', min: 0 },
  { key: 'costUsd', label: '费用', unit: 'USD', min: 0 },
  { key: 'minutes', label: '时长', unit: '分钟', min: 0 },
  { key: 'concurrency', label: '并发节点', unit: '个', min: 1 },
]

/** 档位多选：四个开关按钮，每个带档位图标；全不选表示不限档位（删除该键）。 */
function TierPicker({ id, value, disabled, onCommit }: { id: string; value: Tier[]; disabled: boolean; onCommit(next: Tier[]): void }) {
  return (
    <div className="wf-tiers" id={id} role="group" aria-label="适用档位">
      {TIERS.map((t) => {
        const on = value.includes(t)
        return (
          <button
            key={t}
            type="button"
            className={`wf-tier${on ? ' is-on' : ''}`}
            aria-pressed={on}
            disabled={disabled}
            title={`${TIER_LABEL[t].title}：${TIER_LABEL[t].hint}`}
            onClick={() => onCommit(on ? value.filter((x) => x !== t) : TIERS.filter((x) => x === t || value.includes(x)))}
          >
            <TierGlyph tier={t} size={18} label={false} />
            <span className="mono">{t}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 预算：四个数字，空着表示不限；全部清空时删除 budget 键。 */
function BudgetFields({ value, disabled, onCommit }: { value: RunBudget; disabled: boolean; onCommit(next: RunBudget): void }) {
  return (
    <div className="wf-budget">
      {BUDGET_FIELDS.map((f) => {
        const fid = `wf-meta-budget-${f.key}`
        return (
          <label key={f.key} className="wf-budget-cell" htmlFor={fid}>
            <span className="wf-budget-label">
              {f.label}
              <span className="faint">{f.unit}</span>
            </span>
            <NumberInput
              id={fid}
              value={value[f.key]}
              min={f.min}
              disabled={disabled}
              onCommit={(n) => {
                const next = { ...value }
                if (n === undefined) delete next[f.key]
                else next[f.key] = n
                onCommit(next)
              }}
            />
          </label>
        )
      })}
    </div>
  )
}

/**
 * workflow 的路由与总负责元数据（docs/design/19 §1、§7）：适用场景、档位、Lead 准则、动态规则、预算。
 * 都走 setMetaValue；清空即删除该键（源码里不再写）。代码值只读显示。
 */
export function RoutingMeta({ model, disabled, apply }: { model: EditableWorkflow; disabled: boolean; apply: Apply }) {
  const set = (key: MetaKey, value: EditableValue | null, what: string) => apply([{ op: 'setMetaValue', key, value }], `${value ? '修改' : '删除'}${what}`)
  const text = (key: 'useWhen' | 'leadInstructions' | 'dynamicRules', label: string, hint: string, rows: number) => {
    const v = model.meta[key]
    const fid = `wf-meta-${key}`
    return (
      <Field label={label} hint={hint} htmlFor={fid}>
        {v?.kind === 'code' ? (
          <CodeValue id={fid} code={v.code} disabled />
        ) : (
          <LongText id={fid} rows={rows} value={literalOf<string>(v) ?? ''} disabled={disabled} onCommit={(s) => set(key, s.trim() ? lit(s.trim()) : null, label)} />
        )}
      </Field>
    )
  }
  const tiersV = model.meta.tiers
  const budgetV = model.meta.budget
  return (
    <section className="wf-meta-routing" aria-labelledby="wf-meta-routing-title">
      <div className="wf-meta-section-head">
        <span id="wf-meta-routing-title" className="section-label">路由与总负责</span>
        <span className="faint">路由器与 Lead 读这些</span>
      </div>
      {text('useWhen', '适用场景', '路由器据此在多个 workflow 之间选择；写改动形状，不写技术栈', 3)}
      <Field label="适用档位" hint={(literalOf<Tier[]>(tiersV) ?? []).length === 0 ? '未选：不限档位' : '只按改动形状分档；人可以在路由卡上改档'} htmlFor="wf-meta-tiers">
        {tiersV?.kind === 'code' ? (
          <CodeValue id="wf-meta-tiers" code={tiersV.code} disabled />
        ) : (
          <TierPicker id="wf-meta-tiers" value={literalOf<Tier[]>(tiersV) ?? []} disabled={disabled} onCommit={(t) => set('tiers', t.length ? lit(t) : null, '适用档位')} />
        )}
      </Field>
      {text('leadInstructions', 'Lead 准则', '给 Lead 的总负责准则：怎么问人、什么时候 @ 谁', 4)}
      {text('dynamicRules', '动态规则', '运行中允许 Lead 提议的调整；提议仍需负责人批准', 3)}
      <Field label="预算" hint="空着表示不限；用到 80% 时在需求页告警">
        {budgetV?.kind === 'code' ? (
          <CodeValue id="wf-meta-budget" code={budgetV.code} disabled />
        ) : (
          <BudgetFields value={literalOf<RunBudget>(budgetV) ?? {}} disabled={disabled} onCommit={(b) => set('budget', Object.keys(b).length ? lit(b) : null, '预算')} />
        )}
      </Field>
    </section>
  )
}
