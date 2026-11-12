import type { RequirementSummary, RunSummary } from '@taktflow/core'
import type { FieldSpec, FieldValue } from './schema'

/** 常见枚举值的中文名（未知值原样显示）。 */
const ENUM_LABEL: Record<string, string> = {
  resolved: '已解决',
  dismissed: '驳回',
  open: '重新打开',
  tentative: '试用',
  active: '启用',
  retired: '退役',
  approve: '批准',
  reject: '驳回',
  answer: '回答',
  choice: '选择',
  accept: '接受',
  undo: '撤销',
  critical: '严重',
  major: '重要',
  minor: '次要',
  node: '节点',
  skill: '技能',
  recipe: '配方',
}

interface FieldProps {
  f: FieldSpec
  value: FieldValue
  onChange: (v: FieldValue) => void
  fromContext: boolean
  reqs: RequirementSummary[]
  runs: RunSummary[]
  /** 已选需求时，运行下拉只列这个需求的运行 */
  requirementId?: string
  autoFocus?: boolean
}

export function CommandField({ f, value, onChange, fromContext, reqs, runs, requirementId, autoFocus }: FieldProps) {
  const id = `cmdf-${f.key}`
  const str = typeof value === 'string' ? value : ''
  const label = (
    <span className="ov-field-label">
      <label id={`${id}-l`} htmlFor={id}>{f.title}</label>
      {f.required && <span className="ov-req">必填</span>}
      {fromContext && <span className="cmdk-ctx-tag">来自当前页面</span>}
      {f.description && <span className="ov-field-hint">{f.description}</span>}
    </span>
  )

  if (f.type === 'boolean') {
    return (
      <div className="ov-field">
        <label className="cmdk-check">
          <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} autoFocus={autoFocus} />
          <span>{f.title}</span>
        </label>
      </div>
    )
  }

  let control
  if (f.key === 'requirementId' && reqs.length) {
    control = (
      <select id={id} className="select" value={str} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}>
        {!str && <option value="">选择需求…</option>}
        {reqs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.id} · {r.title}
          </option>
        ))}
      </select>
    )
  } else if (f.key === 'runId' && runs.length) {
    const list = runs.filter((r) => !requirementId || r.requirementId === requirementId || r.runId === str).slice(0, 30)
    control = (
      <select id={id} className="select" value={str} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}>
        {!str && <option value="">选择运行…</option>}
        {list.map((r) => (
          <option key={r.runId} value={r.runId}>
            {r.runId} · {r.requirementId}
          </option>
        ))}
      </select>
    )
  } else if (f.type === 'enum' && f.options) {
    if (f.required && f.options.length <= 4) {
      control = (
        <div className="segmented cmdk-seg" role="radiogroup" aria-labelledby={`${id}-l`}>
          {f.options.map((o, i) => (
            <button key={o} type="button" role="radio" aria-checked={o === str} className={o === str ? 'on' : undefined} onClick={() => onChange(o)} autoFocus={autoFocus && i === 0}>
              {ENUM_LABEL[o] ?? o}
            </button>
          ))}
        </div>
      )
    } else {
      control = (
        <select id={id} className="select" value={str} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}>
          <option value="">{f.required ? '选择…' : '（不指定）'}</option>
          {f.options.map((o) => (
            <option key={o} value={o}>
              {ENUM_LABEL[o] ? `${ENUM_LABEL[o]}（${o}）` : o}
            </option>
          ))}
        </select>
      )
    }
  } else if (f.type === 'json') {
    control = <textarea id={id} className="textarea mono" rows={3} value={str} onChange={(e) => onChange(e.target.value)} placeholder="JSON" autoFocus={autoFocus} />
  } else {
    control = (
      <input
        id={id}
        className={`input${/Id$|^id$|rev/.test(f.key) ? ' mono' : ''}`}
        type={f.type === 'number' ? 'number' : 'text'}
        value={str}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
      />
    )
  }
  return (
    <div className="ov-field">
      {label}
      {control}
    </div>
  )
}
