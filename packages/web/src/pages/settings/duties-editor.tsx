import { useId, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { DUTY_RULE, dutyError } from './rules'

/** 常用职责标签：节点 owner 写的就是这些（docs/design/19）。 */
export const COMMON_DUTIES: Array<{ id: string; label: string }> = [
  { id: 'pm', label: '产品' },
  { id: 'arch', label: '架构' },
  { id: 'rd', label: '研发' },
  { id: 'qa', label: '测试' },
  { id: 'ops', label: '运维' },
]

/**
 * 成员职责标签：节点的负责人（owner）匹配到职责时，待办派给这个成员。
 * 点 × 移除；"+ 职责"展开一个小输入框，回车添加，Esc 取消；建议项来自常用职责与空间里已有的标签。
 * 输入不合法时在框下写出规则，失焦也保留输入，不悄悄丢掉。
 */
export function DutiesEditor({ name, value, known, onChange }: { name: string; value: string[]; known: string[]; onChange(next: string[]): void }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const listId = `duties-${name}`
  const hintId = useId()
  const suggestions = [...new Set([...COMMON_DUTIES.map((d) => d.id), ...known])].filter((d) => !value.includes(d))
  const t = text.trim().toLowerCase()
  const error = dutyError(text, value)
  const valid = t !== '' && !error

  function add() {
    if (!valid) return
    onChange([...value, t])
    setText('')
    setAdding(false)
  }

  return (
    <div className="duties" aria-label={`${name} 的职责`}>
      {value.map((d) => (
        <span key={d} className="duty-tag mono" title={COMMON_DUTIES.find((c) => c.id === d)?.label ?? d}>
          {d}
          <button type="button" className="duty-remove" aria-label={`移除职责 ${d}`} onClick={() => onChange(value.filter((x) => x !== d))}>
            <X />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="input duty-input mono"
          autoFocus
          list={listId}
          value={text}
          placeholder="rd"
          aria-label={`给 ${name} 添加职责`}
          aria-invalid={Boolean(error)}
          aria-describedby={hintId}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => (valid ? add() : t === '' && setAdding(false))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
            if (e.key === 'Escape') {
              setAdding(false)
              setText('')
            }
          }}
        />
      ) : (
        <button type="button" className="duty-add" onClick={() => setAdding(true)} title="职责标签：节点负责人匹配时，待办派给此人">
          <Plus />
          {value.length === 0 ? '职责' : ''}
        </button>
      )}
      {adding && (
        <span id={hintId} className={`duty-hint${error ? ' is-bad' : ''}`} role={error ? 'alert' : undefined}>
          {error ?? (t && t !== text.trim() ? `会存成小写：${t}` : `${DUTY_RULE}；回车添加，Esc 取消`)}
        </span>
      )}
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s}>
            {COMMON_DUTIES.find((c) => c.id === s)?.label ?? s}
          </option>
        ))}
      </datalist>
    </div>
  )
}
