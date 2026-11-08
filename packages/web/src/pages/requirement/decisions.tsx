import type { CSSProperties } from 'react'
import { ArrowRight, CircleHelp, Gauge, GitFork, History, Lightbulb, ListChecks, Repeat2, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { AttentionItem, BudgetStatus, RequirementDetail, RunDetail } from '@taktflow/core'
import { useAsync } from '../../api'
import { fmtRelative } from '../../lib/format'
import { Link } from '../../lib/router'
import { toneSoftVar, toneVar, type Tone } from '../../lib/status'

interface Decision {
  key: string
  /** 越小越急：0 预算用尽 / 1 重复失败 / 2 过期审批 / 3 普通待办 / 4 预算告警。 */
  urgency: number
  at: string
  tone: Tone
  icon: LucideIcon
  kind: string
  title: string
  detail?: string
  nodeLabel?: string
  assignees?: string[]
  to: string
  action: string
}

const FORM_LABEL: Record<AttentionItem['form'], { kind: string; icon: LucideIcon; action: string }> = {
  approve: { kind: '审批', icon: ShieldCheck, action: '去审批' },
  answer: { kind: '回答', icon: CircleHelp, action: '去回答' },
  choice: { kind: '选择', icon: ListChecks, action: '去选择' },
}

function nodeHref(a: AttentionItem) {
  return `/run/${a.runId}?node=${encodeURIComponent(a.nodeId)}`
}

/** 过期审批：列出"批的是 v1，现在是 v2"。 */
function staleDetail(a: AttentionItem, detail?: RequirementDetail): string | undefined {
  const refs = a.boundTo ?? []
  const parts = refs.flatMap((ref) => {
    const rec = detail?.artifacts.find((r) => r.path === ref.path)
    const now = rec?.versions[rec.versions.length - 1]?.version
    if (!ref.version || !now || now <= ref.version) return []
    return [`${ref.path} v${ref.version} → v${now}`]
  })
  return parts.length ? `审批对象已更新：${parts.join('，')}` : '审批对象已更新，请按新版本重新确认'
}

function fromAttention(a: AttentionItem, detail: RequirementDetail | undefined, titleOf: (id: string) => string | undefined): Decision {
  const base = { key: a.requestId, at: a.createdAt, title: a.ask, nodeLabel: titleOf(a.nodeId) ?? a.nodeId, assignees: a.assignees, to: nodeHref(a) }
  if (a.kind === 'budget') return { ...base, urgency: 0, tone: 'failed', icon: Gauge, kind: '预算用尽', action: '去处理' }
  if (a.kind === 'retry') return { ...base, urgency: 1, tone: 'failed', icon: Repeat2, kind: '重复失败', action: '去裁决' }
  if (a.stale) return { ...base, urgency: 2, tone: 'stale', icon: History, kind: '审批已过期', detail: staleDetail(a, detail), action: '重新审批' }
  if (a.kind === 'route') return { ...base, urgency: 3, tone: 'waiting', icon: GitFork, kind: '改档确认', action: '去确认' }
  if (a.kind === 'assumption') return { ...base, urgency: 3, tone: 'waiting', icon: Lightbulb, kind: '待确认假设', title: `没等到回答，系统按假设推进了：${a.assumption ?? ''}`, detail: '确认假设，或改答让相关节点重跑', to: '/attention', action: '去确认' }
  if (a.kind === 'workflow_change') return { ...base, urgency: 3, tone: 'waiting', icon: GitFork, kind: '流程变更', action: '去确认' }
  const f = FORM_LABEL[a.form]
  return { ...base, urgency: 3, tone: 'waiting', icon: f.icon, kind: f.kind, action: f.action }
}

function fromBudget(b: BudgetStatus, runId: string | undefined, at: string): Decision | undefined {
  if (!runId || b.state === 'ok') return undefined
  const pct = Math.round(b.ratio * 100)
  if (b.state === 'exhausted')
    return { key: 'budget', urgency: 0, at, tone: 'failed', icon: Gauge, kind: '预算用尽', title: `预算已用到 ${pct}%，新节点已暂停调度`, detail: '追加 50% 预算，或停止这次运行', to: `/run/${runId}`, action: '去处理' }
  return { key: 'budget', urgency: 4, at, tone: 'waiting', icon: Gauge, kind: '预算告警', title: `预算已用到 ${pct}%`, detail: '到 100% 会停止调度新节点；可以提前追加或收窄范围', to: `/run/${runId}`, action: '看运行' }
}

/**
 * 需要你决策（D 组）：需求页阶段条下方，按紧急程度列出待办、预算告警 / 用尽、重复失败（retry.suppressed）、过期审批。
 * 待办由组件自己用 ds.attention() 拉取并按 requirementId 过滤；run 是最近一次流水线运行（可能还在加载）。
 */
export function Decisions({ requirementId, detail, run, budget }: { requirementId: string; detail?: RequirementDetail; run?: RunDetail; budget?: BudgetStatus }) {
  const q = useAsync((ds) => ds.attention(true), [requirementId, detail?.pendingAttention, detail?.updatedAt])
  const titleOf = (id: string) => run?.graph.nodes.find((n) => n.id === id)?.title
  const pending = (q.data ?? []).filter((a) => a.requirementId === requirementId && !a.answeredAt)
  const items = pending.map((a) => fromAttention(a, detail, titleOf))
  // 预算用尽时引擎会发 budget 待办；已有就不再合成一条
  const b = budget && !pending.some((a) => a.kind === 'budget') ? fromBudget(budget, run?.run.runId, run?.run.startedAt ?? '') : undefined
  if (b) items.push(b)
  items.sort((x, y) => x.urgency - y.urgency || Date.parse(x.at) - Date.parse(y.at))
  if (!items.length) return null
  const urgent = items.filter((d) => d.urgency < 3).length
  return (
    <section className="card req-decisions" aria-label="需要你决策">
      <header className="req-decisions-head">
        <h3 className="card-title">需要你决策</h3>
        <span className="faint num">{items.length} 项</span>
        {urgent > 0 && <span className="req-decisions-urgent num">{urgent} 项紧急</span>}
        <span className="spacer" />
        <Link to="/attention" className="btn btn-ghost btn-sm">
          全部待办
        </Link>
      </header>
      <ol className="req-decisions-list">
        {items.map((d, i) => (
          <li key={d.key} className="decision-row" style={{ '--tone': toneVar(d.tone), '--tone-soft': toneSoftVar(d.tone), '--i': i } as CSSProperties}>
            <span className="decision-icon" aria-hidden>
              <d.icon />
            </span>
            <span className="decision-kind">{d.kind}</span>
            <span className="decision-body">
              <span className="decision-title" title={d.title}>
                {d.title}
              </span>
              <span className="decision-meta">
                {d.detail && <span className="decision-detail">{d.detail}</span>}
                {d.nodeLabel && <span>{d.nodeLabel}</span>}
                {d.assignees?.length ? <span>派给 {d.assignees.join('、')}</span> : null}
                {d.at && <span title={d.at}>{fmtRelative(d.at)}</span>}
              </span>
            </span>
            <Link to={d.to} className="btn btn-sm decision-go">
              {d.action}
              <ArrowRight />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  )
}
