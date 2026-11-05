import { useState, type ReactNode } from 'react'
import { Ban, Bot, ChevronDown, ChevronRight, Copy, ExternalLink, Wrench } from 'lucide-react'
import { useAsync, useSource, type AgentTraceView } from '../../api'
import { EmptyState, ErrorState, SkeletonRows, StatusBadge, toast } from '../../components/ui'
import { fmtDate, fmtDuration, fmtTokens } from '../../lib/format'
import { setQuery } from '../../lib/router'
import { NODE_STATUS, type StatusMeta } from '../../lib/status'

/** 子 Agent 状态沿用节点状态的徽标。 */
const AGENT_STATUS: Record<AgentTraceView['status'], StatusMeta> = {
  starting: { ...NODE_STATUS.ready, label: '启动中' },
  running: NODE_STATUS.running,
  completed: { ...NODE_STATUS.succeeded, label: '已完成' },
  failed: NODE_STATUS.failed,
  cancelled: NODE_STATUS.cancelled,
}

function duration(t: AgentTraceView, now: number): string {
  if (t.durationMs !== undefined) return fmtDuration(t.durationMs)
  return fmtDuration((t.endedAt ? Date.parse(t.endedAt) : now) - Date.parse(t.startedAt))
}

function tokens(t: AgentTraceView): string {
  return t.usage ? fmtTokens(t.usage.inputTokens + t.usage.outputTokens) : '—'
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="faint">{empty}</span>
  return (
    <span className="agent-chips">
      {items.map((x) => (
        <span key={x} className="chip mono">
          {x}
        </span>
      ))}
    </span>
  )
}

/** 可折叠的长文本（prompt、最终回复）。 */
function Fold({ title, text, open: initial = false }: { title: string; text?: string; open?: boolean }) {
  const [open, setOpen] = useState(initial)
  if (!text) return null
  return (
    <section className="agent-fold">
      <div className="d-section-title agent-fold-head">
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown /> : <ChevronRight />}
          {title}
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast(`已复制${title}`))}>
          <Copy />
          复制
        </button>
      </div>
      {open && <pre className="prompt-view agent-text">{text}</pre>}
    </section>
  )
}

/** 一次子 Agent 执行的完整追溯：身份与能力、prompt、工具调用、被拒操作、结果。 */
export function AgentTraceCard({ t, now = Date.now() }: { t: AgentTraceView; now?: number }) {
  const ds = useSource()
  return (
    <article className="agent-card">
      <header className="agent-card-head">
        <Bot aria-hidden />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="agent-card-title truncate">
            {t.profile.title} <span className="mono faint">#{t.attempt}</span>
          </div>
          <div className="drawer-sub">
            <span className="mono truncate">{t.label}</span>
          </div>
        </div>
        <StatusBadge meta={AGENT_STATUS[t.status]} />
        {ds.openAgentSession && (
          <button className="btn btn-sm" onClick={() => ds.openAgentSession!(t)} title="在宿主里打开这个子 Agent 的会话">
            <ExternalLink />
            打开会话
          </button>
        )}
      </header>

      {t.error && (
        <div className="d-callout failed">
          <div>
            <b>执行失败</b>
            <div className="mono">{t.error}</div>
          </div>
        </div>
      )}

      <dl className="facts">
        <Fact label="角色">
          <span className="mono">{t.role}</span>
          <span className="faint"> · 档案来自{t.profile.source === 'space' ? '空间' : '插件默认'}</span>
        </Fact>
        <Fact label="模型">
          <span className="mono">{t.model ?? '—'}</span>
          {t.effort && <span className="faint"> · {t.effort}</span>}
        </Fact>
        <Fact label="耗时 / Token">
          <span className="mono num">
            {duration(t, now)} · {tokens(t)}
          </span>
          {t.usage?.cacheReadTokens ? <span className="faint"> · 缓存 {fmtTokens(t.usage.cacheReadTokens)}</span> : null}
        </Fact>
        <Fact label="开始">
          <span className="mono">{fmtDate(t.startedAt)}</span>
        </Fact>
        <Fact label="Skill">
          <Chips items={t.profile.skills} empty="无" />
        </Fact>
        <Fact label="写范围">
          {t.profile.readOnly ? <span className="faint">只读</span> : <Chips items={t.profile.writeScope} empty="不可写" />}
        </Fact>
        <Fact label="Preset">
          <span className="mono">{t.preset.id}</span>
          <span className="faint"> · {t.preset.plugins.length} 个插件</span>
        </Fact>
        <Fact label="会话">
          <span className="mono truncate">{t.sessionId}</span>
        </Fact>
        {t.stopReason && (
          <Fact label="结束原因">
            <span className="mono">{t.stopReason}</span>
          </Fact>
        )}
      </dl>

      {t.denials.length > 0 && (
        <section>
          <div className="d-section-title">
            <Ban aria-hidden /> 被权限拦下 · {t.denials.length}
          </div>
          <ul className="agent-list">
            {t.denials.map((x, i) => (
              <li key={i} className="agent-row denied">
                <span className="mono">{x.tool}</span>
                {x.path && <span className="mono truncate">{x.path}</span>}
                <span className="faint truncate">{x.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="d-section-title">
          <Wrench aria-hidden /> 工具调用 · {t.tools.length}
        </div>
        {t.tools.length === 0 ? (
          <div className="faint agent-empty">还没有工具调用</div>
        ) : (
          <ol className="agent-list">
            {t.tools.map((x, i) => (
              <li key={i} className={`agent-row${x.ok === false ? ' failed' : ''}`} title={fmtDate(x.at)}>
                <span className="mono agent-tool">{x.name}</span>
                <span className="truncate">{x.summary}</span>
                {x.durationMs !== undefined && <span className="mono faint num">{fmtDuration(x.durationMs)}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <Fold title="Prompt" text={t.prompt} />
      <Fold title="追加的系统说明" text={t.systemAppend} />
      <Fold title="最终回复" text={t.finalText} open={t.status !== 'running'} />
    </article>
  )
}

/** 节点抽屉里的“子 Agent”页：这个节点（含评审的作者 / 评审者）每次执行的追溯，最近的在前。 */
export function AgentsTab({ runId, nodeId, liveTick }: { runId: string; nodeId: string; liveTick: number }) {
  const ds = useSource()
  const q = useAsync((d) => d.agents!(runId, nodeId), [runId, nodeId, liveTick])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data) return <div className="dpad"><SkeletonRows rows={4} /></div>
  if (q.data.length === 0) return <EmptyState icon={Bot} title="这个节点还没有子 Agent" hint="dsh-host 执行的节点启动后会出现在这里。" compact />
  const now = Date.now()
  return (
    <div className="dpad agent-stack">
      {[...q.data].reverse().map((t) => (
        <AgentTraceCard key={`${t.nodeId}#${t.attempt}`} t={t} now={now} />
      ))}
      {!ds.openAgentSession && <div className="faint">在 dsh 里可以直接打开子 Agent 的会话。</div>}
    </div>
  )
}

/** 运行页的“子 Agent”面板：整次运行里所有子 Agent，点击跳到对应节点。 */
export function RunAgentsPanel({ runId, liveTick, onClose }: { runId: string; liveTick: number; onClose: () => void }) {
  const q = useAsync((d) => d.agents!(runId), [runId, liveTick])
  const now = Date.now()
  return (
    <aside className="drawer agent-panel" aria-label="子 Agent">
      <div className="drawer-head">
        <div className="drawer-title-row">
          <Bot aria-hidden />
          <div className="drawer-title" style={{ flex: 1 }}>
            子 Agent {q.data && <span className="faint num">· {q.data.length}</span>}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      <div className="drawer-body">
        {q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={q.reload} />
        ) : !q.data ? (
          <div className="dpad"><SkeletonRows rows={6} /></div>
        ) : q.data.length === 0 ? (
          <EmptyState icon={Bot} title="还没有子 Agent" compact />
        ) : (
          <ul className="agent-list dpad">
            {q.data.map((t) => (
              <li key={`${t.nodeId}#${t.attempt}`}>
                <button className="agent-row agent-pick" onClick={() => setQuery({ panel: undefined, node: t.nodeId, dtab: 'agents' })}>
                  <StatusBadge meta={AGENT_STATUS[t.status]} subtle />
                  <span className="truncate">
                    <b>{t.profile.title}</b> <span className="mono faint">{t.nodeId}#{t.attempt}</span>
                  </span>
                  <span className="mono faint num">{duration(t, now)}</span>
                  <span className="mono faint num">{tokens(t)}</span>
                  <span className="mono faint num" title="工具调用">{t.tools.length}</span>
                  {t.denials.length > 0 && <span className="mono num agent-denied" title="被拦下的操作">{t.denials.length}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
