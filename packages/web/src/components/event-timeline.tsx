import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Cpu,
  CheckCheck,
  ClipboardCheck,
  ChevronRight,
  CircleDot,
  FilePen,
  FilePlus2,
  GitBranch,
  FileWarning,
  Flag,
  History,
  Layers,
  MessageSquare,
  Network,
  Play,
  Reply,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  Shrink,
  RotateCw,
  Send,
  SquareStack,
  TimerOff,
  Undo2,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { EventEnvelope, EventPayloads, ReviewResponse, ReviewVerdict } from '@taktflow/core'
import { actorName, fmtDate, fmtTime, fmtTokens, totalTokens } from '../lib/format'
import { Link } from '../lib/router'
import { NODE_STATUS, VERDICT, toneVar, type Tone } from '../lib/status'
import { toolAction } from '../lib/actions'
import { prefersReducedMotion } from '../lib/motion'
import { ActionText, actionIcon } from './action-row'
import { describeM3 } from './event-timeline-m3'
import './event-timeline.css'

export interface Described {
  icon: LucideIcon
  tone: Tone | 'neutral' | 'accent'
  title: ReactNode
  detail?: ReactNode
}

const REVIEW_VERDICT: Record<ReviewVerdict, { label: string; tone: Tone; mark: string }> = {
  approve: { label: '通过', tone: 'success', mark: '✓' },
  request_changes: { label: '要求修改', tone: 'waiting', mark: '!' },
  reject: { label: '否决', tone: 'failed', mark: '✕' },
}
const RESPONSE_ACTION: Record<ReviewResponse['action'], string> = { fixed: '已修', declined: '不采纳', deferred: '延后' }
const EXHAUSTED_ACTION = { rework: '打回上游重做', human: '交人处理', fail: '节点失败' } as const

const d = <T extends keyof EventPayloads>(e: EventEnvelope, _t: T) => e.data as EventPayloads[T]

/** 事件的图标、色调、一句话标题与可选详情；事件滚动条也用它。 */
export function describe(e: EventEnvelope): Described {
  switch (e.type) {
    case 'run.started':
      return { icon: Play, tone: 'accent', title: <>运行开始 · <span className="mono">{d(e, 'run.started').workflowId}@{d(e, 'run.started').workflowVersion}</span></> }
    case 'run.finished': {
      const s = d(e, 'run.finished').status
      return { icon: Flag, tone: s === 'succeeded' ? 'success' : s === 'failed' ? 'failed' : 'skipped', title: `运行结束：${s}` }
    }
    case 'node.ready':
      return { icon: CircleDot, tone: 'neutral', title: '就绪' }
    case 'node.started': {
      const x = d(e, 'node.started')
      return { icon: Play, tone: 'running', title: <>开始执行{x.iteration ? ` · 第 ${x.iteration} 轮` : ''}{x.attempt > 1 ? ` · 第 ${x.attempt} 次尝试` : ''}</> }
    }
    case 'node.finished': {
      const x = d(e, 'node.finished')
      const meta = NODE_STATUS[x.status]
      return { icon: meta.icon, tone: meta.tone, title: <>结束：{meta.label}{x.usage ? <span className="faint mono"> · {fmtTokens(totalTokens(x.usage))} tok</span> : null}</> }
    }
    case 'node.failed':
      return { icon: X, tone: 'failed', title: '失败', detail: <pre className="ev-pre">{d(e, 'node.failed').error}</pre> }
    case 'node.stale':
      return { icon: History, tone: 'stale', title: <>标记过期：上游 <span className="mono">{d(e, 'node.stale').cause.path}@v{d(e, 'node.stale').cause.version}</span> 被修改</> }
    case 'artifact.written': {
      const x = d(e, 'artifact.written')
      return { icon: FilePlus2, tone: 'success', title: <>写入产物 <span className="mono">{x.ref.path}@v{x.ref.version}</span></>, detail: <span className="mono faint">sha256 {x.sha256.slice(0, 16)}…</span> }
    }
    case 'artifact.edited': {
      const x = d(e, 'artifact.edited')
      const cosmetic = x.impact === 'cosmetic'
      return {
        icon: FilePen,
        tone: cosmetic ? 'neutral' : 'waiting',
        title: <>人工修改 <span className="mono">{x.ref.path}@v{x.ref.version}</span>{cosmetic ? ' · 措辞调整' : ' · 语义修改'}</>,
        detail: <>原因：{x.reason}{cosmetic && <span className="faint"> · 不影响下游</span>}</>,
      }
    }
    case 'artifact.untracked':
      return { icon: FileWarning, tone: 'waiting', title: <>发现绕过引擎的改动 <span className="mono">{d(e, 'artifact.untracked').path}</span></> }
    case 'gate.result': {
      const x = d(e, 'gate.result')
      return {
        icon: ShieldCheck,
        tone: x.pass ? 'success' : 'failed',
        title: <>门禁{x.pass ? '通过' : '未通过'}</>,
        detail: (
          <ul className="ev-list">
            {x.checks.map((c) => (
              <li key={c.id}>
                <span style={{ color: toneVar(c.pass ? 'success' : 'failed') }}>{c.pass ? '✓' : '✕'}</span> <span className="mono">{c.id}</span>
                {c.score !== undefined && <b className="num"> {c.score}</b>} {c.message && <span className="muted">— {c.message}</span>}
              </li>
            ))}
          </ul>
        ),
      }
    }
    case 'judge.verdict': {
      const x = d(e, 'judge.verdict')
      return {
        icon: Scale,
        tone: 'accent',
        title: <>判决 {x.verdicts.length} 条</>,
        detail: (
          <ul className="ev-list">
            {x.verdicts.map((v) => (
              <li key={v.subject}>
                <span className="mono">{v.subject}</span> → <span style={{ color: VERDICT[v.category].color }}>{VERDICT[v.category].label}</span>
                <span className="faint num"> · {Math.round(v.confidence * 100)}%</span> · 路由 <span className="mono">{x.routed.find((r) => r.subject === v.subject)?.to ?? '—'}</span>
              </li>
            ))}
          </ul>
        ),
      }
    }
    case 'human.requested':
      return { icon: UserRound, tone: 'waiting', title: <>等待人工：{d(e, 'human.requested').ask}</> }
    case 'human.answered': {
      const x = d(e, 'human.answered')
      return { icon: CheckCheck, tone: 'success', title: <>人工处理：{x.decision === 'approve' ? '通过' : x.decision === 'reject' ? '打回' : x.decision ?? '已回答'}</>, detail: x.answer }
    }
    case 'harness.started': {
      const x = d(e, 'harness.started')
      return { icon: Cpu, tone: 'neutral', title: <>启动 harness <span className="mono">{x.harness}</span>{x.model && <span className="faint mono"> · {x.model}</span>}</>, detail: x.sessionId && <span className="mono faint">session {x.sessionId}</span> }
    }
    case 'harness.message': {
      const x = d(e, 'harness.message')
      return { icon: MessageSquare, tone: 'neutral', title: <span className="ev-msg">{x.text}</span> }
    }
    case 'harness.tool_call': {
      const x = d(e, 'harness.tool_call')
      const a = toolAction(x.tool, x.input, x.output, x.ok)
      return {
        icon: actionIcon(a),
        tone: x.ok === false ? 'failed' : 'neutral',
        title: <ActionText action={a} />,
        detail: (
          <>
            <div className="ev-tool-raw">
              <span className="ev-tool">{x.tool}</span> <span className="mono">{x.input}</span>
            </div>
            {x.output && <pre className="ev-pre">{x.output}</pre>}
          </>
        ),
      }
    }
    case 'harness.usage': {
      const x = d(e, 'harness.usage')
      return { icon: SquareStack, tone: 'neutral', title: <>用量 <span className="mono">in {fmtTokens(x.inputTokens)} · out {fmtTokens(x.outputTokens)}{x.cachedTokens ? ` · cache ${fmtTokens(x.cachedTokens)}` : ''}</span></> }
    }
    case 'context.assembled': {
      const x = d(e, 'context.assembled')
      const over = x.totalTokens > x.budgetTokens
      return { icon: Layers, tone: over ? 'failed' : 'neutral', title: <>上下文组装 <span className="mono">{fmtTokens(x.totalTokens)} / {fmtTokens(x.budgetTokens)}</span>{over && ' · 超预算'} · {x.items.length} 项</> }
    }
    case 'context.compacted': {
      const x = d(e, 'context.compacted')
      return { icon: Shrink, tone: 'stale', title: <>上下文压缩 <span className="mono">{fmtTokens(x.beforeTokens)} → {fmtTokens(x.afterTokens)}</span></>, detail: x.summary }
    }
    case 'knowledge.query': {
      const x = d(e, 'knowledge.query')
      return { icon: Search, tone: 'neutral', title: <>知识检索「{x.query.text}」· {x.hits} 条命中</>, detail: <span className="mono faint">{x.sources.join(' / ')} · intent={x.query.intent}</span> }
    }
    case 'dag.expanded': {
      const x = d(e, 'dag.expanded')
      return { icon: Network, tone: 'accent', title: <>动态展开 {x.items.length} 个条目 · {x.nodeIds.length} 个节点</>, detail: <span className="mono faint">{x.items.map((i) => i.key).join(', ')}</span> }
    }
    case 'guard.violation': {
      const x = d(e, 'guard.violation')
      return { icon: ShieldAlert, tone: 'failed', title: <>守卫违规（{x.action === 'reverted' ? '已还原' : x.action === 'blocked' ? '已拦截' : '已标记'}）<span className="mono"> {x.rule}</span></>, detail: <span className="mono">{x.paths.join(', ')}</span> }
    }
    case 'log': {
      const x = d(e, 'log')
      return { icon: ChevronRight, tone: x.level === 'error' ? 'failed' : x.level === 'warn' ? 'waiting' : 'neutral', title: x.message }
    }
    case 'review.round': {
      const x = d(e, 'review.round')
      const issues = x.verdicts.reduce((n, v) => n + v.issues, 0)
      return {
        icon: ClipboardCheck,
        tone: x.passed ? 'success' : 'waiting',
        title: <>评审第 {x.round} 轮{x.passed ? '通过' : `未通过 · ${issues} 个问题`}</>,
        detail: (
          <ul className="ev-list">
            {x.verdicts.map((v) => (
              <li key={v.reviewer}>
                <span style={{ color: toneVar(REVIEW_VERDICT[v.verdict].tone) }}>{REVIEW_VERDICT[v.verdict].mark}</span> <span className="mono">{v.reviewer}</span> {REVIEW_VERDICT[v.verdict].label}
                {v.score !== undefined && <b className="num"> {v.score}</b>}
                {v.issues > 0 && <span className="muted"> — {v.issues} 个问题</span>}
              </li>
            ))}
          </ul>
        ),
      }
    }
    case 'review.response': {
      const x = d(e, 'review.response')
      const count = (a: ReviewResponse['action']) => x.responses.filter((r) => r.action === a).length
      const parts = (['fixed', 'declined', 'deferred'] as const).filter((a) => count(a)).map((a) => `${RESPONSE_ACTION[a]} ${count(a)}`)
      return {
        icon: Reply,
        tone: 'neutral',
        title: <>作者回应第 {x.round} 轮评审 · {parts.join(' · ')}</>,
        detail: x.revised.length > 0 && <span className="mono faint">修改后 {x.revised.map((r) => `${r.path}@v${r.version}`).join(', ')}</span>,
      }
    }
    case 'review.exhausted': {
      const x = d(e, 'review.exhausted')
      return { icon: TimerOff, tone: x.action === 'fail' ? 'failed' : x.action === 'human' ? 'waiting' : 'stale', title: <>评审 {x.rounds} 轮仍未通过 · {EXHAUSTED_ACTION[x.action]}</> }
    }
    case 'rework.started': {
      const x = d(e, 'rework.started')
      return {
        icon: Undo2,
        tone: 'stale',
        title: <>打回 <span className="mono">{x.to}</span> 重做 · 第 {x.count} 次</>,
        detail: (
          <>
            <span className="mono faint">重置 {x.reset.join(', ')}</span>
            {x.feedback && <pre className="ev-pre">{x.feedback}</pre>}
          </>
        ),
      }
    }
    case 'worktree.created': {
      const x = d(e, 'worktree.created')
      return { icon: GitBranch, tone: 'neutral', title: <>创建 worktree <span className="mono">{x.repo}:{x.branch}</span></>, detail: <span className="mono faint">基于 {x.base} · {x.path}</span> }
    }
    case 'task.dispatched': {
      const x = d(e, 'task.dispatched')
      if (x.resendOf)
        return {
          icon: RotateCw,
          tone: 'running',
          title: <>重发任务「{x.title}」给 <span className="mono">{x.role}</span></>,
          detail: (
            <span className="faint">
              <span className="mono">{x.taskRunId}</span> · 替代 <span className="mono">{x.resendOf}</span> · 由 {actorName(x.by)} 重发{x.reason ? `：${x.reason}` : ''}
            </span>
          ),
        }
      return { icon: Send, tone: 'running', title: <>派发任务「{x.title}」给 <span className="mono">{x.role}</span></>, detail: <span className="mono faint">{x.taskRunId} · 由 {actorName(x.by)} 派发</span> }
    }
    default:
      return describeM3(e) ?? { icon: ChevronRight, tone: 'neutral', title: <span className="mono">{e.type}</span> }
  }
}

export const toneColor = (t: Described['tone']) => (t === 'neutral' ? 'var(--text-3)' : t === 'accent' ? 'var(--accent)' : toneVar(t))

export function EventTimeline({ events, showNode, showRun, showDate, focusSeq }: { events: EventEnvelope[]; showNode?: boolean; showRun?: boolean; showDate?: boolean; focusSeq?: number }) {
  return (
    <ol className="ev-timeline">
      {events.map((e) => (
        <EventRow key={`${e.runId}-${e.seq}`} e={e} showNode={showNode} showRun={showRun} showDate={showDate} focus={e.seq === focusSeq} />
      ))}
    </ol>
  )
}

function EventRow({ e, showNode, showRun, showDate, focus }: { e: EventEnvelope; showNode?: boolean; showRun?: boolean; showDate?: boolean; focus?: boolean }) {
  const info = describe(e)
  const collapsible = e.type === 'harness.tool_call' || e.type === 'harness.started' || e.type === 'rework.started' || e.type === 'worktree.bootstrapped'
  const [open, setOpen] = useState(!collapsible || Boolean(focus))
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [focus])
  const Icon = info.icon
  return (
    <li ref={ref} className={`ev-row${collapsible ? ' collapsible' : ''}${focus ? ' is-focus' : ''}`} style={{ '--ev-tone': toneColor(info.tone) } as CSSProperties}>
      <span className="ev-time mono num" title={`seq ${e.seq} · ${e.ts}\nhash ${e.hash}`}>
        {showDate ? (
          <>
            {fmtDate(e.ts).slice(0, 5)}
            <br />
            {fmtTime(e.ts)}
          </>
        ) : (
          fmtTime(e.ts)
        )}
      </span>
      <span className="ev-icon">
        <Icon strokeWidth={2.2} />
      </span>
      <div className="ev-body">
        <div className="ev-title" onClick={collapsible && info.detail ? () => setOpen((o) => !o) : undefined}>
          {collapsible && info.detail && <ChevronRight className={`ev-caret${open ? ' open' : ''}`} />}
          <span className="ev-title-text">{info.title}</span>
        </div>
        {info.detail && open && <div className="ev-detail">{info.detail}</div>}
        <div className="ev-meta">
          <span>{actorName(e.actor)}</span>
          {showNode && e.nodeId && (
            <Link to={`/run/${e.runId}?node=${encodeURIComponent(e.nodeId)}`} className="mono ev-link">
              {e.nodeId}
            </Link>
          )}
          {showRun && (
            <Link to={`/run/${e.runId}`} className="mono ev-link">
              {e.runId}
            </Link>
          )}
          <span className="mono faint">#{e.seq}</span>
        </div>
      </div>
    </li>
  )
}
