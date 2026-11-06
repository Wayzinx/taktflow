import { BookCheck, BookMarked, BookOpen, Gauge, GitBranch, Gavel, ListChecks, MessageSquareWarning, Repeat2, Route } from 'lucide-react'
import type { EventEnvelope, EventPayloads, RunBudget } from '@taktflow/core'
import { actorName, fmtDuration, fmtTokens } from '../lib/format'
import { toneVar } from '../lib/status'
import type { Described } from './event-timeline'

/**
 * docs/design/19 新增事件的展示（M3）：完成标准自检、失败指纹抑制、预算、路由、经验库、
 * 评审裁决与人工处置、worktree 引导。拆出来是为了让 event-timeline.tsx 保持可读。
 */

const d = <T extends keyof EventPayloads>(e: EventEnvelope, _t: T) => e.data as EventPayloads[T]

const LESSON_STATUS = { tentative: '试用', active: '启用', retired: '退役' } as const
const LESSON_SOURCE = { judge: '判决', review: '评审', human: '人工' } as const
const DISPOSITION = { open: '重新打开', resolved: '已解决', dismissed: '驳回' } as const
const ARBITER_VERDICT = { approve: '通过', request_changes: '要求修改', reject: '否决' } as const

function budgetLine(b: RunBudget, used: { tokens: number; costUsd?: number; minutes: number }) {
  const parts: string[] = []
  if (b.tokens) parts.push(`token ${fmtTokens(used.tokens)} / ${fmtTokens(b.tokens)}`)
  if (b.costUsd) parts.push(`成本 $${(used.costUsd ?? 0).toFixed(2)} / $${b.costUsd.toFixed(2)}`)
  if (b.minutes) parts.push(`时长 ${Math.round(used.minutes)} / ${b.minutes} 分钟`)
  return parts.join(' · ')
}

export function describeM3(e: EventEnvelope): Described | undefined {
  switch (e.type) {
    case 'node.checks': {
      const x = d(e, 'node.checks')
      const passed = x.checks.filter((c) => c.pass).length
      return {
        icon: ListChecks,
        tone: x.unmet.length ? 'failed' : 'success',
        title: x.unmet.length ? <>完成标准未满足 · {x.unmet.length} 条</> : <>完成标准自检 {passed}/{x.checks.length} 通过</>,
        detail: (
          <ul className="ev-list">
            {x.checks.map((c) => (
              <li key={c.id}>
                <span style={{ color: toneVar(c.pass && c.evidence ? 'success' : 'failed') }}>{c.pass && c.evidence ? '✓' : '✕'}</span> {c.criterion}
                {c.evidence && <span className="mono faint"> — {c.evidence}</span>}
              </li>
            ))}
          </ul>
        ),
      }
    }
    case 'retry.suppressed': {
      const x = d(e, 'retry.suppressed')
      return {
        icon: Repeat2,
        tone: 'failed',
        title: <>同样的失败第 {x.count} 次 · 已停止重试 <span className="mono">{x.code}</span></>,
        detail: (
          <>
            {x.reason} <span className="mono faint">· 指纹 {x.fingerprint}</span>
          </>
        ),
      }
    }
    case 'budget.warning':
    case 'budget.exhausted': {
      const x = d(e, 'budget.warning')
      const out = e.type === 'budget.exhausted'
      return { icon: Gauge, tone: out ? 'failed' : 'waiting', title: <>{out ? '预算用尽' : '预算告警'} · 已用 <span className="mono num">{Math.round(x.ratio * 100)}%</span></>, detail: <span className="mono faint">{budgetLine(x.budget, x.used)}</span> }
    }
    case 'route.decided': {
      const x = d(e, 'route.decided')
      return {
        icon: Route,
        tone: 'accent',
        title: (
          <>
            路由 <span className="mono">{x.tier}</span> → <span className="mono">{x.workflowId}</span>
            {x.overridden && <> · {actorName(x.overridden.by)} 从 <span className="mono">{x.overridden.from}</span> 改档</>}
          </>
        ),
        detail: (
          <>
            {x.reason}
            {x.adjustments?.map((a) => (
              <div key={a} className="faint">
                调整：{a}
              </div>
            ))}
          </>
        ),
      }
    }
    case 'lesson.recalled': {
      const x = d(e, 'lesson.recalled')
      return { icon: BookOpen, tone: 'neutral', title: <>召回经验 {x.ids.length} 条{x.holdout ? ' · 对照组（未注入）' : ''}</>, detail: <span className="mono faint">{x.ids.join(', ')} · {fmtTokens(x.tokens)} tok</span> }
    }
    case 'lesson.learned': {
      const x = d(e, 'lesson.learned')
      return { icon: BookMarked, tone: 'accent', title: <>沉淀经验「{x.title}」· 来自{LESSON_SOURCE[x.source.kind]}</>, detail: <span className="mono faint">{x.id} · 试用中</span> }
    }
    case 'lesson.updated': {
      const x = d(e, 'lesson.updated')
      return { icon: BookCheck, tone: x.status === 'retired' ? 'skipped' : 'success', title: <>经验 <span className="mono">{x.id}</span> → {LESSON_STATUS[x.status]}</>, detail: <>原因：{x.reason}<span className="faint mono"> · 召回 {x.stats.recalled} · 帮助 {x.stats.helped} · 坑 {x.stats.hurt}</span></> }
    }
    case 'review.arbitrated': {
      const x = d(e, 'review.arbitrated')
      return { icon: Gavel, tone: 'accent', title: <>第 {x.round} 轮裁决 · <span className="mono">{x.arbiter}</span> 判定{ARBITER_VERDICT[x.verdict]}</>, detail: <>分歧：{x.conflict}</> }
    }
    case 'review.disposition': {
      const x = d(e, 'review.disposition')
      return { icon: MessageSquareWarning, tone: x.state === 'open' ? 'waiting' : 'neutral', title: <>人工处置问题 <span className="mono">{x.groupKey}</span> · {DISPOSITION[x.state]}</>, detail: <>原因：{x.reason}</> }
    }
    case 'worktree.bootstrapped': {
      const x = d(e, 'worktree.bootstrapped')
      return {
        icon: GitBranch,
        tone: x.ok ? 'neutral' : 'failed',
        title: <>worktree 引导{x.ok ? '完成' : '失败'} <span className="mono">{x.repo}</span><span className="faint mono"> · {fmtDuration(x.ms)}</span></>,
        detail: (
          <>
            {x.command && <div className="mono">$ {x.command}</div>}
            {x.shared && x.shared.length > 0 && <div className="mono faint">共享 {x.shared.join(', ')}</div>}
            {x.output && <pre className="ev-pre">{x.output}</pre>}
          </>
        ),
      }
    }
    default:
      return undefined
  }
}
