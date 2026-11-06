import { useAsync } from '../../../api'
import { useDraft } from './fields'
import { withCurrent, type Option } from './options'

const FALLBACK_DUTIES: Array<[string, string]> = [
  ['pm', '产品'],
  ['arch', '架构'],
  ['rd', '研发'],
  ['qa', '测试'],
]

/** 负责人下拉：空间成员的职责标签（duties），标签后列出会收到待办的成员；空间没配职责时给常用标签兜底。 */
export function useDutyOptions(): Option[] {
  const { data } = useAsync((ds) => ds.space(), [])
  const byDuty = new Map<string, string[]>()
  for (const m of data?.members ?? []) for (const d of m.duties ?? []) byDuty.set(d, [...(byDuty.get(d) ?? []), m.name])
  if (byDuty.size === 0) return FALLBACK_DUTIES.map(([value, label]) => ({ value, label: `${value} · ${label}` }))
  return [...byDuty.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, names]) => ({ value, label: `${value} · ${names.join('、')}` }))
}

export function DutySelect({ id, value, options, disabled, onCommit }: { id: string; value?: string; options: Option[]; disabled?: boolean; onCommit(v: string | undefined): void }) {
  const unknown = !!value && !options.some((o) => o.value === value)
  return (
    <select id={id} className="select" value={value ?? ''} disabled={disabled} onChange={(e) => onCommit(e.target.value || undefined)} aria-invalid={unknown || undefined}>
      <option value="">不指定（待办不派给具体的人）</option>
      {withCurrent(options, value).map((o) => (
        <option key={o.value} value={o.value}>
          {o.value === value && unknown ? `${value}（空间里没有成员承担这个职责）` : o.label}
        </option>
      ))}
    </select>
  )
}

export interface ArbiterValue {
  role: string
  focus?: string
}

/** 裁决者：只在评审者结论冲突时调用（有人通过、有人要求修改且含 blocker）。角色为空即删除。 */
export function ArbiterField({ id, value, roles, disabled, onCommit }: { id: string; value?: ArbiterValue; roles: Option[]; disabled?: boolean; onCommit(v: ArbiterValue | undefined): void }) {
  const [focus, setFocus, dirty] = useDraft(value?.focus ?? '')
  const commit = (role: string | undefined, f: string) => {
    if (!role) return onCommit(undefined)
    const { focus: _old, ...rest }: ArbiterValue = value ?? { role }
    void _old
    onCommit(f.trim() ? { ...rest, role, focus: f.trim() } : { ...rest, role })
  }
  return (
    <div className="wf-arbiter" id={id}>
      <select className="select" aria-label="裁决者角色" value={value?.role ?? ''} disabled={disabled} onChange={(e) => commit(e.target.value || undefined, focus)}>
        <option value="">不设裁决者（冲突时按通过规则）</option>
        {withCurrent(roles, value?.role).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {value?.role && (
        <input
          className="input"
          placeholder="裁决侧重点，例如：以可测性为准"
          aria-label="裁决侧重点"
          value={focus}
          disabled={disabled}
          onChange={(e) => setFocus(e.target.value)}
          onBlur={() => dirty && commit(value.role, focus)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      )}
    </div>
  )
}
