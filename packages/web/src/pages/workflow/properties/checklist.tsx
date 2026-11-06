import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'

interface Row {
  k: number
  text: string
}

let seq = 0
const rowsOf = (v: string[]): Row[] => v.map((text) => ({ k: ++seq, text }))

/**
 * 完成标准清单：每条一行、可增删排序。条目编号 c1、c2 … 与运行时 completionChecks 对应，
 * 所以排序会改变编号（提示里说明）。提交时机：失焦、回车新增、删除、上下移动；空行不提交。
 * 新增的行 140ms 淡入并下移 3px；移动不加动画（即时反馈）。
 */
export function ChecklistEditor({ id, value, disabled, onCommit }: { id: string; value: string[]; disabled?: boolean; onCommit(next: string[]): void }) {
  const key = JSON.stringify(value)
  const [rows, setRows] = useState<Row[]>(() => rowsOf(value))
  const [fresh, setFresh] = useState<number>()
  const focusK = useRef<number | undefined>(undefined)
  const inputs = useRef(new Map<number, HTMLInputElement>())
  /** 自己刚提交的值：回流时不重置草稿（保留空的新行、行 key 与焦点）。 */
  const sent = useRef<string | undefined>(undefined)
  // 外部值变了（撤销、远端修改）：丢弃草稿
  useEffect(() => {
    if (key === sent.current) {
      sent.current = undefined
      return
    }
    setRows(rowsOf(value))
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focusK.current === undefined) return
    inputs.current.get(focusK.current)?.focus()
    focusK.current = undefined
  })

  const commit = (next: Row[]) => {
    const clean = next.map((r) => r.text.trim()).filter(Boolean)
    const s = JSON.stringify(clean)
    if (s === key) return
    sent.current = s
    onCommit(clean)
  }
  const insertAt = (i: number) => {
    const row = { k: ++seq, text: '' }
    const next = [...rows.slice(0, i), row, ...rows.slice(i)]
    setRows(next)
    setFresh(row.k)
    focusK.current = row.k
    return next
  }
  const move = (i: number, dir: -1 | 1) => {
    const next = [...rows]
    ;[next[i], next[i + dir]] = [next[i + dir]!, next[i]!]
    setRows(next)
    focusK.current = next[i + dir]!.k
    commit(next)
  }
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i)
    setRows(next)
    focusK.current = next[Math.max(0, i - 1)]?.k
    commit(next)
  }

  return (
    <div className="wf-checklist" id={id}>
      {rows.length === 0 && <p className="wf-checklist-empty">还没有完成标准：节点以进程退出码判定成败。</p>}
      <ol className="wf-checklist-rows">
        {rows.map((r, i) => (
          <li key={r.k} className={`wf-checklist-row${r.k === fresh ? ' is-fresh' : ''}`}>
            <span className="wf-checklist-no mono num" aria-hidden>
              c{i + 1}
            </span>
            <input
              ref={(el) => {
                if (el) inputs.current.set(r.k, el)
                else inputs.current.delete(r.k)
              }}
              className="input"
              value={r.text}
              disabled={disabled}
              placeholder="一条可验证的标准，例如：本地单测全部通过"
              aria-label={`完成标准 c${i + 1}`}
              onChange={(e) => setRows(rows.map((x) => (x.k === r.k ? { ...x, text: e.target.value } : x)))}
              onBlur={(e) => {
                // 焦点还在清单内（移动、删除按钮、新行）时不提交，避免一次操作产生两条修订
                if (e.relatedTarget instanceof Node && e.currentTarget.closest('.wf-checklist')?.contains(e.relatedTarget)) return
                commit(rows)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (r.text.trim()) commit(insertAt(i + 1))
                }
                if (e.key === 'Backspace' && r.text === '' && rows.length > 0) {
                  e.preventDefault()
                  remove(i)
                }
                if (e.key === 'ArrowUp' && e.altKey && i > 0) {
                  e.preventDefault()
                  move(i, -1)
                }
                if (e.key === 'ArrowDown' && e.altKey && i < rows.length - 1) {
                  e.preventDefault()
                  move(i, 1)
                }
              }}
            />
            {!disabled && (
              <span className="wf-row-tools">
                <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`上移 c${i + 1}`} title="上移（⌥↑）">
                  <ArrowUp />
                </button>
                <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label={`下移 c${i + 1}`} title="下移（⌥↓）">
                  <ArrowDown />
                </button>
                <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => remove(i)} aria-label={`删除 c${i + 1}`}>
                  <Trash2 />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!disabled && (
        <button type="button" className="btn btn-sm wf-add-row" onClick={() => insertAt(rows.length)}>
          <Plus />
          添加一条
        </button>
      )}
    </div>
  )
}
