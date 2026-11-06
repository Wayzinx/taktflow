import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react'
import type { EditableValue } from '@taktflow/core'
import { findNode, lit, literalOf } from '../../../api/workflow-edit'
import { useRoleOptions, withCurrent } from '../properties/options'
import type { WorkflowDocState } from '../state'
import { addNode, type Placement } from './add-node'
import { prefersReducedMotion } from '../../../lib/motion'

interface Draft {
  title: string
  upstream: string
  targetKind: 'paths' | 'code'
  paths: string
  repo: string
  author: string
  reviewers: Array<{ role: string; focus: string }>
  pass: 'all' | 'majority' | 'minScore'
  minScore: number
  maxRounds: number
  humanSignoff: boolean
  exhausted: 'human' | 'fail' | 'rework'
  rework: string
  maxReworks: number
}

const STEPS = ['评审对象', '评审者', '通过规则', '轮次用尽'] as const

/** 构造 review 节点的 props；与 core 的 ReviewNodeDef 字段一一对应。 */
function toProps(d: Draft): Record<string, EditableValue> {
  const target = d.targetKind === 'code' ? { code: { repo: d.repo || 'app' } } : d.paths.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
  return {
    title: lit(d.title || '交叉评审'),
    ...(d.upstream ? { needs: lit([d.upstream]) } : {}),
    target: lit(target),
    author: lit({ role: d.author }),
    reviewers: lit(d.reviewers.filter((r) => r.role).map((r) => (r.focus ? { role: r.role, focus: r.focus } : { role: r.role }))),
    ...(d.pass === 'all' ? {} : { pass: lit(d.pass === 'majority' ? 'majority' : { minScore: d.minScore }) }),
    maxRounds: lit(d.maxRounds),
    ...(d.humanSignoff ? { humanSignoff: lit(true) } : {}),
    onExhausted: lit(d.exhausted === 'rework' ? { rework: d.rework, maxReworks: d.maxReworks } : d.exhausted),
  }
}

export function ReviewWizard({ wf, placement, onClose, onDone }: { wf: WorkflowDocState; placement: Placement; onClose(): void; onDone?(id: string): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const roles = useRoleOptions()
  const siblings = useMemo(() => {
    const m = wf.model
    if (!m) return []
    const list = placement.parent ? (findNode(m.nodes, placement.parent)?.node.body ?? []) : m.nodes
    return list.filter((n) => n.kind !== 'review')
  }, [wf.model, placement.parent])
  const guess = [...siblings].reverse().find((n) => placement.parent || literalOf<string>(n.props.stage) === placement.stage) ?? siblings[siblings.length - 1]
  const guessRole = (guess && literalOf<string>(guess.props.role)) || 'dev'
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [d, setD] = useState<Draft>({
    title: guess ? `${literalOf<string>(guess.props.title) ?? guess.id} 评审` : '交叉评审',
    upstream: guess?.id ?? '',
    targetKind: 'paths',
    paths: '',
    repo: 'app',
    author: guessRole,
    reviewers: [{ role: 'reviewer', focus: '' }],
    pass: 'all',
    minScore: 80,
    maxRounds: 3,
    humanSignoff: true,
    exhausted: guess ? 'rework' : 'human',
    rework: guess?.id ?? '',
    maxReworks: 1,
  })
  const up = (patch: Partial<Draft>) => setD((c) => ({ ...c, ...patch }))
  // 退出动画：先进入 exit 状态保留最后一帧 150ms，再真正关闭（原生 close 事件触发 onClose 卸载）
  const [closing, setClosing] = useState(false)
  const close = () => {
    if (closing) return
    setClosing(true)
    setTimeout(() => ref.current?.close(), prefersReducedMotion() ? 0 : 150)
  }

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const problem = [
    d.targetKind === 'paths' && !d.paths.trim() ? '至少写一个被评审的产物路径' : d.targetKind === 'code' && !d.repo.trim() ? '写上代码仓库 id' : !d.author ? '选择作者角色' : undefined,
    d.reviewers.every((r) => !r.role) ? '至少一位评审者' : d.reviewers.some((r) => r.role && r.role === d.author) ? '评审者不应与作者同一角色' : undefined,
    d.maxRounds < 1 || d.maxRounds > 10 ? '轮次 1–10' : d.pass === 'minScore' && (d.minScore < 0 || d.minScore > 100) ? '分数线 0–100' : undefined,
    d.exhausted === 'rework' && !d.rework ? '选择打回目标' : undefined,
  ][step]

  async function finish() {
    setBusy(true)
    const id = await addNode(wf, 'review', toProps(d), placement)
    setBusy(false)
    if (id) onDone?.(id)
    close()
  }

  const roleSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">选择角色</option>
      {withCurrent(roles, value).map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )

  return (
    <dialog
      ref={ref}
      className="wf-dialog wf-wizard"
      data-state={closing ? 'exit' : 'open'}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      aria-labelledby="wf-wizard-title"
    >
      <header className="wf-dialog-head">
        <h2 id="wf-wizard-title">新增评审节点</h2>
        <span className="muted">{placement.parent ? `放入 ${placement.parent}` : placement.stage ? `阶段 ${placement.stage}` : ''}</span>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={close} aria-label="关闭">
          <X />
        </button>
      </header>
      <ol className="wf-steps" aria-label="步骤">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'is-current' : i < step ? 'is-done' : undefined} aria-current={i === step ? 'step' : undefined}>
            <span className="mono num">{i < step ? <Check /> : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <div className="wf-dialog-body">
        {step === 0 && (
          <>
            <label className="wf-field"><span>标题</span><input className="input" value={d.title} onChange={(e) => up({ title: e.target.value })} /></label>
            <label className="wf-field">
              <span>上游（被评审的产出节点）</span>
              <select className="select" value={d.upstream} onChange={(e) => up({ upstream: e.target.value, rework: d.rework || e.target.value })}>
                <option value="">不依赖</option>
                {siblings.map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}
              </select>
            </label>
            <div className="wf-field">
              <span>评审对象</span>
              <div className="wf-radio-row" role="radiogroup">
                <label><input type="radio" checked={d.targetKind === 'paths'} onChange={() => up({ targetKind: 'paths' })} />产物路径</label>
                <label><input type="radio" checked={d.targetKind === 'code'} onChange={() => up({ targetKind: 'code' })} />代码改动</label>
              </div>
              {d.targetKind === 'paths' ? (
                <textarea className="textarea mono" rows={3} placeholder={'spec/prd.md\ndesign/**'} value={d.paths} onChange={(e) => up({ paths: e.target.value })} aria-label="产物路径，每行一个" />
              ) : (
                <input className="input mono" value={d.repo} onChange={(e) => up({ repo: e.target.value })} aria-label="代码仓库 id" />
              )}
            </div>
            <label className="wf-field"><span>作者（按意见修改的角色）</span>{roleSelect(d.author, (author) => up({ author }), '作者角色')}</label>
          </>
        )}
        {step === 1 && (
          <div className="wf-field">
            <span>评审者（各自独立上下文）</span>
            {d.reviewers.map((r, i) => (
              <div className="wf-list-row" key={i}>
                {roleSelect(r.role, (role) => up({ reviewers: d.reviewers.map((x, j) => (j === i ? { ...x, role } : x)) }), `第 ${i + 1} 位评审者角色`)}
                <input className="input" placeholder="评审侧重点" value={r.focus} onChange={(e) => up({ reviewers: d.reviewers.map((x, j) => (j === i ? { ...x, focus: e.target.value } : x)) })} aria-label={`第 ${i + 1} 位评审侧重点`} />
                <button className="btn btn-ghost btn-sm btn-icon" disabled={d.reviewers.length === 1} onClick={() => up({ reviewers: d.reviewers.filter((_, j) => j !== i) })} aria-label="移除评审者"><Trash2 /></button>
              </div>
            ))}
            <button className="btn btn-sm wf-add-row" onClick={() => up({ reviewers: [...d.reviewers, { role: '', focus: '' }] })}><Plus />添加评审者</button>
          </div>
        )}
        {step === 2 && (
          <>
            <div className="wf-field">
              <span>通过规则</span>
              <div className="wf-radio-col" role="radiogroup">
                <label><input type="radio" checked={d.pass === 'all'} onChange={() => up({ pass: 'all' })} />全部评审者通过</label>
                <label><input type="radio" checked={d.pass === 'majority'} onChange={() => up({ pass: 'majority' })} />多数通过</label>
                <label><input type="radio" checked={d.pass === 'minScore'} onChange={() => up({ pass: 'minScore' })} />平均分不低于<input className="input wf-num" type="number" min={0} max={100} value={d.minScore} disabled={d.pass !== 'minScore'} onChange={(e) => up({ minScore: Number(e.target.value) })} aria-label="分数线" /></label>
              </div>
            </div>
            <label className="wf-field"><span>最多轮次（含首轮）</span><input className="input wf-num" type="number" min={1} max={10} value={d.maxRounds} onChange={(e) => up({ maxRounds: Number(e.target.value) })} /></label>
            <label className="wf-check"><input type="checkbox" checked={d.humanSignoff} onChange={(e) => up({ humanSignoff: e.target.checked })} />评审者全部通过后再交人确认</label>
          </>
        )}
        {step === 3 && (
          <div className="wf-field">
            <span>轮次用尽仍未通过时</span>
            <div className="wf-radio-col" role="radiogroup">
              <label><input type="radio" checked={d.exhausted === 'rework'} onChange={() => up({ exhausted: 'rework' })} />打回上游重做</label>
              <label><input type="radio" checked={d.exhausted === 'human'} onChange={() => up({ exhausted: 'human' })} />交人裁决</label>
              <label><input type="radio" checked={d.exhausted === 'fail'} onChange={() => up({ exhausted: 'fail' })} />直接失败</label>
            </div>
            {d.exhausted === 'rework' && (
              <div className="wf-list-row">
                <select className="select" value={d.rework} onChange={(e) => up({ rework: e.target.value })} aria-label="打回目标">
                  <option value="">打回目标</option>
                  {siblings.map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}
                </select>
                <label className="wf-inline">最多打回<input className="input wf-num" type="number" min={1} max={5} value={d.maxReworks} onChange={(e) => up({ maxReworks: Number(e.target.value) })} />次</label>
              </div>
            )}
          </div>
        )}
      </div>
      <footer className="wf-dialog-foot">
        <span className="wf-problem" role="status">{problem}</span>
        <button className="btn btn-sm" onClick={() => (step ? setStep(step - 1) : close())}>{step ? <><ChevronLeft />上一步</> : '取消'}</button>
        {step < STEPS.length - 1 ? (
          <button className="btn btn-sm btn-primary" disabled={!!problem} onClick={() => setStep(step + 1)}>下一步<ChevronRight /></button>
        ) : (
          <button className="btn btn-sm btn-primary" disabled={!!problem || busy} onClick={() => void finish()}><Check />创建评审节点</button>
        )}
      </footer>
    </dialog>
  )
}
