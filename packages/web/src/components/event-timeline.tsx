import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  Bot,
  CheckCheck,
  ChevronRight,
  CircleDot,
  FilePen,
  FilePlus2,
  FileWarning,
  Flag,
  Hammer,
  History,
  Layers,
  MessageSquare,
  Network,
  Play,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  Shrink,
  SquareStack,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { EventEnvelope, EventPayloads } from '@taktflow/core'
import { actorName, fmtDate, fmtTime, fmtTokens, totalTokens } from '../lib/format'
import { Link } from '../lib/router'
import { NODE_STATUS, VERDICT, toneVar, type Tone } from '../lib/status'
import './event-timeline.css'

interface Described {
  icon: LucideIcon
  tone: Tone | 'neutral' | 'accent'
  title: ReactNode
  detail?: ReactNode
}

const d = <T extends keyof EventPayloads>(e: EventEnvelope, _t: T) => e.data as EventPayloads[T]

function describe(e: EventEnvelope): Described {
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
      return { icon: FilePen, tone: 'waiting', title: <>人工修改 <span className="mono">{x.ref.path}@v{x.ref.version}</span></>, detail: <>原因：{x.reason}</> }
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
      return { icon: Bot, tone: 'neutral', title: <>启动 harness <span className="mono">{x.harness}</span>{x.model && <span className="faint mono"> · {x.model}</span>}</>, detail: x.sessionId && <span className="mono faint">session {x.sessionId}</span> }
    }
    case 'harness.message': {
      const x = d(e, 'harness.message')
      return { icon: MessageSquare, tone: 'neutral', title: <span className="ev-msg">{x.text}</span> }
    }
    case 'harness.tool_call': {
      const x = d(e, 'harness.tool_call')
      return {
        icon: Hammer,
        tone: x.ok === false ? 'failed' : 'neutral',
        title: (
          <>
            <span className="ev-tool">{x.tool}</span> <span className="mono">{x.input}</span>
          </>
        ),
        detail: x.output && <pre className="ev-pre">{x.output}</pre>,
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
  }
}

const toneColor = (t: Described['tone']) => (t === 'neutral' ? 'var(--text-3)' : t === 'accent' ? 'var(--accent)' : toneVar(t))

export function EventTimeline({ events, showNode, showRun, showDate }: { events: EventEnvelope[]; showNode?: boolean; showRun?: boolean; showDate?: boolean }) {
  return (
    <ol className="ev-timeline">
      {events.map((e) => (
        <EventRow key={`${e.runId}-${e.seq}`} e={e} showNode={showNode} showRun={showRun} showDate={showDate} />
      ))}
    </ol>
  )
}

function EventRow({ e, showNode, showRun, showDate }: { e: EventEnvelope; showNode?: boolean; showRun?: boolean; showDate?: boolean }) {
  const info = describe(e)
  const collapsible = e.type === 'harness.tool_call' || e.type === 'harness.started'
  const [open, setOpen] = useState(!collapsible)
  const Icon = info.icon
  return (
    <li className={`ev-row${collapsible ? ' collapsible' : ''}`} style={{ '--ev-tone': toneColor(info.tone) } as CSSProperties}>
      <span className="ev-time mono num" title={`seq ${e.seq} · ${e.ts}\nhash ${e.hash}`}>
        {showDate ? fmtDate(e.ts) : fmtTime(e.ts)}
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
