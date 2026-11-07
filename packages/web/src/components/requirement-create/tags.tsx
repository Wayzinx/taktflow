import { useState } from 'react'
import { CalendarClock, CircleDollarSign, FolderGit2, Users } from 'lucide-react'
import type { RunBudget, SpaceDetail } from '@taktflow/core'
import { Avatar } from '../ui'
import { duePresets, fmtBudget, fmtDue, fromDateInput, toDateInput } from './draft'
import { CheckRow, Tag } from './tag'

type Repo = SpaceDetail['repos'][number]

export function RepoTag({ repos, value, onChange }: { repos?: Repo[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Tag icon={FolderGit2} label="仓库" value={value.length ? value.join('、') : undefined} onClear={() => onChange([])} width={280}>
      {() =>
        !repos?.length ? (
          <p className="rc-pop-empty">这个空间还没有绑定仓库，可以在空间设置的"仓库"里添加。</p>
        ) : (
          <div className="rc-check-list">
            {repos.map((r) => (
              <CheckRow key={r.id} checked={value.includes(r.id)} onChange={(on) => onChange(on ? [...value, r.id] : value.filter((x) => x !== r.id))} hint={<span className="mono">{r.defaultBranch}</span>}>
                <span className="mono">{r.id}</span>
              </CheckRow>
            ))}
            <p className="rc-pop-foot">不选时按改动面自动判断。</p>
          </div>
        )
      }
    </Tag>
  )
}

export function PeopleTag({ members, owner, value, onOwner, onChange }: { members?: SpaceDetail['members']; owner?: string; value: string[]; onOwner: (id: string) => void; onChange: (v: string[]) => void }) {
  const shown = owner ? [owner, ...value.filter((m) => m !== owner)] : value
  return (
    <Tag
      icon={Users}
      label="负责人与成员"
      value={
        shown.length ? (
          <span className="rc-people">
            {shown.slice(0, 3).map((m) => (
              <Avatar key={m} name={members?.find((x) => x.id === m)?.name ?? m} size={16} />
            ))}
            <span>{members?.find((x) => x.id === owner)?.name ?? owner ?? '未指定'}</span>
            {value.filter((m) => m !== owner).length > 0 && <span className="faint">+{value.filter((m) => m !== owner).length}</span>}
          </span>
        ) : undefined
      }
      width={300}
    >
      {() => (
        <div className="rc-check-list">
          {(members ?? []).map((m) => (
            <div key={m.id} className="rc-person">
              <CheckRow checked={m.id === owner || value.includes(m.id)} onChange={(on) => onChange(on ? [...value, m.id] : value.filter((x) => x !== m.id))} hint={m.duties?.join(' / ')}>
                <Avatar name={m.name} size={18} />
                {m.name}
              </CheckRow>
              <button type="button" className={`rc-owner-btn${m.id === owner ? ' on' : ''}`} onClick={() => onOwner(m.id)} aria-pressed={m.id === owner} title="设为负责人">
                {m.id === owner ? '负责人' : '设为负责人'}
              </button>
            </div>
          ))}
          {!members?.length && <p className="rc-pop-empty">空间还没有成员，需求会记在你名下。</p>}
        </div>
      )}
    </Tag>
  )
}

const BUDGET_PRESETS: Array<{ label: string; b: RunBudget }> = [
  { label: '$5 · 小改动', b: { costUsd: 5 } },
  { label: '$20 · 常规', b: { costUsd: 20 } },
  { label: '$50 · 较大', b: { costUsd: 50 } },
]

export function BudgetTag({ value, onChange }: { value?: RunBudget; onChange: (v?: RunBudget) => void }) {
  return (
    <Tag icon={CircleDollarSign} label="预算" value={fmtBudget(value)} onClear={() => onChange(undefined)} width={300}>
      {(close) => <BudgetForm value={value} onDone={(b) => (onChange(b), close())} />}
    </Tag>
  )
}

function BudgetForm({ value, onDone }: { value?: RunBudget; onDone: (b?: RunBudget) => void }) {
  const [cost, setCost] = useState(value?.costUsd ? String(value.costUsd) : '')
  const [tokens, setTokens] = useState(value?.tokens ? String(value.tokens / 10_000) : '')
  const [minutes, setMinutes] = useState(value?.minutes ? String(value.minutes) : '')
  const apply = () => {
    const b: RunBudget = {}
    if (Number(cost) > 0) b.costUsd = Number(cost)
    if (Number(tokens) > 0) b.tokens = Math.round(Number(tokens) * 10_000)
    if (Number(minutes) > 0) b.minutes = Math.round(Number(minutes))
    onDone(Object.keys(b).length ? b : undefined)
  }
  return (
    <div className="rc-form">
      <div className="rc-presets">
        {BUDGET_PRESETS.map((p) => (
          <button key={p.label} type="button" className="btn btn-sm" onClick={() => onDone(p.b)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="rc-grid3">
        <label className="ov-field">
          <span className="ov-field-label">费用（美元）</span>
          <input className="input num" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="20" />
        </label>
        <label className="ov-field">
          <span className="ov-field-label">tokens（万）</span>
          <input className="input num" inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="300" />
        </label>
        <label className="ov-field">
          <span className="ov-field-label">时长（分钟）</span>
          <input className="input num" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="90" />
        </label>
      </div>
      <p className="rc-pop-foot">超出任一项时暂停并来问你。</p>
      <div className="rc-pop-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={apply}>
          确定
        </button>
      </div>
    </div>
  )
}

export function DueTag({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  return (
    <Tag icon={CalendarClock} label="截止时间" value={value ? fmtDue(value) : undefined} onClear={() => onChange(undefined)} width={260}>
      {(close) => <DuePicker value={value} onPick={(v) => (onChange(v), close())} />}
    </Tag>
  )
}

/** 截止时间：四个快捷项 + 日期输入。需求页头部也用它。 */
export function DuePicker({ value, onPick }: { value?: string; onPick: (v?: string) => void }) {
  return (
    <div className="rc-form">
      <div className="rc-presets">
        {duePresets().map((p) => (
          <button key={p.label} type="button" className={`btn btn-sm${toDateInput(p.at) === toDateInput(value) ? ' btn-primary' : ''}`} onClick={() => onPick(p.at)}>
            {p.label}
          </button>
        ))}
      </div>
      <label className="ov-field">
        <span className="ov-field-label">指定日期</span>
        <input className="input" type="date" value={toDateInput(value)} onChange={(e) => e.target.value && onPick(fromDateInput(e.target.value))} />
      </label>
      {value && (
        <button type="button" className="btn btn-sm btn-ghost rc-clear" onClick={() => onPick(undefined)}>
          不设截止时间
        </button>
      )}
    </div>
  )
}
