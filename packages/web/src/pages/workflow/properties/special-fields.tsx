import type { CSSProperties } from 'react'
import { X } from 'lucide-react'
import type { EditableNode, VerdictCategory } from '@taktflow/core'
import { VERDICT, VERDICT_ORDER } from '../../../lib/status'
import { ListEditor, NumberInput, Select, TextInput } from './fields'
import type { Option } from './options'

/** 依赖：已有依赖列成可删的标签，下拉追加；候选里已排除会成环或跨容器的节点。 */
export function NeedsField({ id, needs, candidates, disabled, onCommit }: { id: string; needs: string[]; candidates: Option[]; disabled?: boolean; onCommit(next: string[]): void }) {
  return (
    <div className="wf-needs" id={id}>
      {needs.length === 0 && <span className="faint">无依赖，阶段开始即可运行</span>}
      {needs.map((n) => (
        <span className="chip mono wf-need" key={n}>
          {n}
          {!disabled && (
            <button onClick={() => onCommit(needs.filter((x) => x !== n))} aria-label={`删除依赖 ${n}`}>
              <X />
            </button>
          )}
        </span>
      ))}
      {!disabled && candidates.length > 0 && (
        <select className="select wf-need-add" value="" onChange={(e) => e.target.value && onCommit([...needs, e.target.value])} aria-label="添加依赖">
          <option value="">+ 添加依赖</option>
          {candidates.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )}
    </div>
  )
}

type Pass = 'all' | 'majority' | { minScore: number } | undefined

export function PassField({ id, value, disabled, onCommit }: { id: string; value: Pass; disabled?: boolean; onCommit(v: Pass): void }) {
  const mode = typeof value === 'object' ? 'minScore' : (value ?? 'all')
  return (
    <div className="wf-inline-row">
      <Select
        id={id}
        value={mode}
        disabled={disabled}
        options={[{ value: 'all', label: '全部通过' }, { value: 'majority', label: '多数通过' }, { value: 'minScore', label: '平均分达标' }]}
        onCommit={(v) => onCommit(v === 'minScore' ? { minScore: 80 } : v === 'majority' ? 'majority' : undefined)}
      />
      {typeof value === 'object' && <NumberInput id={`${id}-score`} value={value.minScore} min={0} max={100} disabled={disabled} onCommit={(n) => onCommit({ minScore: n ?? 80 })} />}
    </div>
  )
}

type Exhausted = 'human' | 'fail' | { rework: string; maxReworks?: number } | undefined

export function ExhaustedField({ id, value, nodes, disabled, onCommit }: { id: string; value: Exhausted; nodes: Option[]; disabled?: boolean; onCommit(v: Exhausted): void }) {
  const mode = typeof value === 'object' ? 'rework' : (value ?? 'human')
  return (
    <div className="wf-stack">
      <Select
        id={id}
        value={mode}
        disabled={disabled}
        options={[{ value: 'rework', label: '打回上游重做' }, { value: 'human', label: '交人裁决' }, { value: 'fail', label: '直接失败' }]}
        onCommit={(v) => onCommit(v === 'rework' ? { rework: nodes[0]?.value ?? '', maxReworks: 1 } : v === 'fail' ? 'fail' : 'human')}
      />
      {typeof value === 'object' && (
        <div className="wf-inline-row">
          <Select id={`${id}-target`} value={value.rework} disabled={disabled} options={nodes} empty="打回目标" onCommit={(v) => onCommit({ ...value, rework: v ?? '' })} />
          <span className="wf-inline">最多</span>
          <NumberInput id={`${id}-max`} value={value.maxReworks ?? 1} min={1} max={5} disabled={disabled} onCommit={(n) => onCommit({ ...value, maxReworks: n ?? 1 })} />
          <span className="wf-inline">次</span>
        </div>
      )}
    </div>
  )
}

export function RoutesField({ id, value, nodes, disabled, onCommit }: { id: string; value: Partial<Record<VerdictCategory, string>>; nodes: Option[]; disabled?: boolean; onCommit(v: Partial<Record<VerdictCategory, string>>): void }) {
  const opts: Option[] = [{ value: 'human', label: '交人（待办）' }, { value: 'ignore', label: '只记录' }, ...nodes]
  return (
    <div className="wf-routes" id={id}>
      {VERDICT_ORDER.map((cat) => (
        <div className="wf-route" key={cat}>
          <span className="wf-route-cat" style={{ '--c': VERDICT[cat].color } as CSSProperties}>{VERDICT[cat].label}</span>
          <Select
            id={`${id}-${cat}`}
            value={value[cat]}
            disabled={disabled}
            options={opts}
            empty="未配置"
            onCommit={(v) => {
              const next = { ...value }
              if (v) next[cat] = v
              else delete next[cat]
              onCommit(next)
            }}
          />
        </div>
      ))}
    </div>
  )
}

type Target = string[] | { code: { repo: string; base?: string } }

export function TargetField({ id, value, disabled, onCommit }: { id: string; value: Target | undefined; disabled?: boolean; onCommit(v: Target): void }) {
  const isCode = !!value && !Array.isArray(value)
  return (
    <div className="wf-stack">
      <div className="wf-radio-row" role="radiogroup" aria-label="评审对象类型">
        <label><input type="radio" checked={!isCode} disabled={disabled} onChange={() => onCommit([])} />产物路径</label>
        <label><input type="radio" checked={isCode} disabled={disabled} onChange={() => onCommit({ code: { repo: 'app' } })} />代码改动</label>
      </div>
      {isCode ? (
        <TextInput id={id} mono value={(value as { code: { repo: string } }).code.repo} disabled={disabled} placeholder="仓库 id" onCommit={(repo) => onCommit({ code: { ...(value as { code: { repo: string } }).code, repo } })} />
      ) : (
        <ListEditor id={id} value={(value as string[] | undefined) ?? []} disabled={disabled} placeholder="spec/**" addLabel="添加路径" onCommit={(v) => onCommit(v as string[])} />
      )}
    </div>
  )
}

/** 同一容器内的其他节点，作为下拉候选。 */
export function siblingOptions(list: EditableNode[], self: string): Option[] {
  return list.filter((n) => n.id !== self).map((n) => ({ value: n.id, label: n.id }))
}
