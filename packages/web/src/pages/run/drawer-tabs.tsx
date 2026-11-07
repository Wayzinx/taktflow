import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowRight, Check, ChevronDown, Copy, ExternalLink, Eye, FileText, Shrink, TriangleAlert, X } from 'lucide-react'
import type { ContextSource, EventEnvelope, EventPayloads, JudgeVerdict, NodeDetail } from '@taktflow/core'
import { useAsync } from '../../api'
import { EventTimeline } from '../../components/event-timeline'
import { EmptyState, Meter, Segmented, Skeleton, StatusBadge, toast } from '../../components/ui'
import { JsonView } from '../../lib/json-view'
import { Markdown } from '../../lib/markdown'
import { durationBetween, fmtCost, fmtDate, fmtDuration, fmtTime, fmtTokens } from '../../lib/format'
import { Link } from '../../lib/router'
import { ARTIFACT_KIND, CONTEXT_SOURCE, NODE_KIND, NODE_STATUS, VERDICT } from '../../lib/status'

const eventsOf = <T extends keyof EventPayloads>(d: NodeDetail, type: T) => d.events.filter((e) => e.type === type) as Array<EventEnvelope<T>>

// ================================================================ 概览

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

export function OverviewTab({ d, runId, requirementId }: { d: NodeDetail; runId: string; requirementId: string }) {
  const s = d.state
  const harness = eventsOf(d, 'harness.started').at(-1)?.data
  const ms = durationBetween(s.startedAt, s.endedAt)
  const u = s.usage
  const human = eventsOf(d, 'human.requested').at(-1)?.data
  const answered = eventsOf(d, 'human.answered').at(-1)
  const expanded = eventsOf(d, 'dag.expanded').at(-1)?.data
  const violations = eventsOf(d, 'guard.violation')
  return (
    <div className="dpad">
      {s.error && (
        <div className="d-callout failed">
          <TriangleAlert />
          <div>
            <b>节点失败</b>
            <div className="mono">{s.error}</div>
          </div>
        </div>
      )}
      {violations.map((v) => (
        <div key={v.seq} className="d-callout failed">
          <TriangleAlert />
          <div>
            <b>守卫违规 · {v.data.action === 'reverted' ? '已还原' : v.data.action === 'blocked' ? '已拦截' : '已标记'}</b>
            <div>
              规则 <span className="mono">{v.data.rule}</span>，越界路径 <span className="mono">{v.data.paths.join(', ')}</span>
            </div>
          </div>
        </div>
      ))}
      <dl className="facts">
        <Fact label="状态">
          <StatusBadge meta={NODE_STATUS[s.status]} />
        </Fact>
        <Fact label="类型">{NODE_KIND[d.kind].label}</Fact>
        {d.role && (
          <Fact label="角色">
            <span className="mono">{d.role}</span>
          </Fact>
        )}
        {harness && (
          <Fact label="Harness">
            <span className="mono">{harness.harness}</span>
            {harness.model && <span className="faint mono"> · {harness.model}</span>}
          </Fact>
        )}
        {s.sessionRef && (
          <Fact label="会话">
            <span className="mono faint">{s.sessionRef.sessionId}</span>
          </Fact>
        )}
        <Fact label="开始">{s.startedAt ? <span className="mono">{fmtDate(s.startedAt)}</span> : <span className="faint">—</span>}</Fact>
        <Fact label="耗时">{ms !== undefined ? <span className="mono">{fmtDuration(ms)}{!s.endedAt && <span className="faint"> · 进行中</span>}</span> : <span className="faint">—</span>}</Fact>
        <Fact label="尝试">
          <span className="mono num">{s.attempts}</span>
          {s.iteration !== undefined && <span className="faint"> · 第 {s.iteration} 轮</span>}
        </Fact>
      </dl>

      {u && (
        <div className="usage-block">
          <div className="usage-tiles">
            <div>
              <label>输入</label>
              <b className="mono num">{fmtTokens(u.inputTokens)}</b>
            </div>
            <div>
              <label>缓存命中</label>
              <b className="mono num">{fmtTokens(u.cachedTokens ?? 0)}</b>
            </div>
            <div>
              <label>输出</label>
              <b className="mono num">{fmtTokens(u.outputTokens)}</b>
            </div>
            <div>
              <label>成本</label>
              <b className="mono num">{fmtCost(u.costUsd)}</b>
            </div>
          </div>
          <div className="usage-bar" title="输入（含缓存） / 输出">
            <span style={{ flex: u.cachedTokens ?? 0, background: 'color-mix(in srgb, var(--c-1) 45%, transparent)' }} />
            <span style={{ flex: u.inputTokens - (u.cachedTokens ?? 0), background: 'var(--c-1)' }} />
            <span style={{ flex: u.outputTokens, background: 'var(--c-3)' }} />
          </div>
        </div>
      )}

      {human && (
        <div className="d-section">
          <div className="d-section-title">人工卡点</div>
          <p className="d-ask">{human.ask}</p>
          {answered ? (
            <div className="d-answer">
              <Check />
              <span>
                <b>{answered.actor.type === 'human' ? answered.actor.id : '—'}</b> {answered.data.decision === 'approve' ? '通过' : answered.data.decision === 'reject' ? '打回' : answered.data.decision === 'choice' ? '裁决' : answered.data.decision ?? '回答'}
                {answered.data.answer && <span className="muted">：{answered.data.answer}</span>}
              </span>
            </div>
          ) : (
            <Link to="/attention" className="btn btn-sm btn-primary">
              去待办处理
            </Link>
          )}
        </div>
      )}

      {expanded && (
        <div className="d-section">
          <div className="d-section-title">规划结果 · {expanded.items.length} 个条目</div>
          <div className="plan-items">
            {expanded.items.map((it) => (
              <div key={it.key} className="plan-item">
                <span className="mono plan-key">{it.key}</span>
                <span className="truncate">{it.title}</span>
                <span style={{ flex: 1 }} />
                {it.dependsOn?.length ? <span className="faint mono">← {it.dependsOn.join(', ')}</span> : null}
                {it.role && <span className="chip mono">{it.role}</span>}
              </div>
            ))}
          </div>
          <p className="faint d-note">模型决定拆成哪些条目，workflow 代码决定每个条目展开成什么节点、最多拆多少、可用哪些角色。</p>
        </div>
      )}

      {d.outputs.length > 0 && (
        <div className="d-section">
          <div className="d-section-title">产出</div>
          <div className="io-list">
            {d.outputs.map((o) => (
              <Link key={`${o.path}@${o.version}`} to={`/req/${requirementId}?path=${encodeURIComponent(o.path)}&v=${o.version}`} className="io-row link">
                <FileText />
                <span className="mono truncate">{o.path}</span>
                <span className="io-ver mono">v{o.version}</span>
                <span style={{ flex: 1 }} />
                <span className="chip">{ARTIFACT_KIND[o.kind as keyof typeof ARTIFACT_KIND] ?? o.kind}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="d-foot faint">
        <span className="mono">{runId}</span> · 共 {d.events.length} 条事件
      </div>
    </div>
  )
}

// ================================================================ 输入输出

function ArtifactInline({ requirementId, path, version }: { requirementId: string; path: string; version?: number }) {
  const q = useAsync((ds) => ds.artifact(requirementId, path, version), [requirementId, path, version])
  if (q.error) return <div className="io-preview faint">{q.error.message}</div>
  if (!q.data)
    return (
      <div className="io-preview">
        <Skeleton w="70%" h={11} />
        <Skeleton w="50%" h={11} style={{ marginTop: 8 }} />
      </div>
    )
  const c = q.data
  return (
    <div className="io-preview">
      {c.encoding === 'base64' ? (
        <img alt={path} src={`data:${c.mediaType};base64,${c.content}`} style={{ maxWidth: '100%', borderRadius: 6 }} />
      ) : c.mediaType.includes('json') ? (
        <JsonView source={c.content} />
      ) : c.mediaType.includes('markdown') ? (
        <Markdown source={c.content} />
      ) : (
        <pre className="json-view">{c.content}</pre>
      )}
    </div>
  )
}

function IoRow({ requirementId, path, version, kind }: { requirementId: string; path: string; version?: number; kind?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`io-item${open ? ' open' : ''}`}>
      <div className="io-row">
        <button className="io-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronDown className="io-caret" />
          <span className="mono truncate">{path}</span>
          {version !== undefined && <span className="io-ver mono">v{version}</span>}
        </button>
        <span style={{ flex: 1 }} />
        {kind && <span className="chip">{ARTIFACT_KIND[kind as keyof typeof ARTIFACT_KIND] ?? kind}</span>}
        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setOpen((o) => !o)} title="预览">
          <Eye />
        </button>
        <Link className="btn btn-ghost btn-sm btn-icon" to={`/req/${requirementId}?path=${encodeURIComponent(path)}${version ? `&v=${version}` : ''}`} title="在需求页查看 / 编辑">
          <ExternalLink />
        </Link>
      </div>
      {open && <ArtifactInline requirementId={requirementId} path={path} version={version} />}
    </div>
  )
}

export function IoTab({ d, requirementId }: { d: NodeDetail; requirementId: string }) {
  return (
    <div className="dpad">
      <div className="d-section first">
        <div className="d-section-title">
          输入 <span className="faint num">{d.inputs.length}</span>
          <span className="faint d-section-hint">节点开始时解析到的版本，用于溯源和过期传播</span>
        </div>
        {d.inputs.length ? (
          <div className="io-list">
            {d.inputs.map((i) => (
              <IoRow key={`${i.path}@${i.version}`} requirementId={requirementId} path={i.path} version={i.version} />
            ))}
          </div>
        ) : (
          <EmptyState compact icon={FileText} title="没有声明输入" />
        )}
      </div>
      <div className="d-section">
        <div className="d-section-title">
          输出 <span className="faint num">{d.outputs.length}</span>
          <span className="faint d-section-hint">结束后由引擎收集、记版本、写 producedBy</span>
        </div>
        {d.outputs.length ? (
          <div className="io-list">
            {d.outputs.map((o) => (
              <IoRow key={`${o.path}@${o.version}`} requirementId={requirementId} path={o.path} version={o.version} kind={o.kind} />
            ))}
          </div>
        ) : (
          <EmptyState compact icon={FileText} title="没有产物" body="脚本或修复类节点可能直接改代码，改动见 Trace。" />
        )}
      </div>
    </div>
  )
}

// ================================================================ Trace

type TraceFilter = 'all' | 'talk' | 'tool' | 'engine'
export function TraceTab({ d }: { d: NodeDetail }) {
  const [f, setF] = useState<TraceFilter>('all')
  const events = d.events.filter((e) =>
    f === 'all' ? true : f === 'talk' ? e.type === 'harness.message' : f === 'tool' ? e.type === 'harness.tool_call' : !e.type.startsWith('harness.'),
  )
  return (
    <div className="dpad">
      <div className="d-toolbar">
        <Segmented<TraceFilter>
          value={f}
          onChange={setF}
          options={[
            { value: 'all', label: `全部 ${d.events.length}` },
            { value: 'talk', label: '消息' },
            { value: 'tool', label: '工具调用' },
            { value: 'engine', label: '引擎 / 门禁 / 守卫' },
          ]}
        />
      </div>
      {events.length ? <EventTimeline events={events} /> : <EmptyState compact icon={FileText} title="没有事件" />}
    </div>
  )
}

// ================================================================ 上下文

const SOURCES: ContextSource[] = ['system', 'role', 'skill', 'artifact', 'knowledge', 'prompt', 'history', 'tool_result']

export function ContextTab({ d }: { d: NodeDetail }) {
  const { snapshots, compactions } = d.context
  const [idx, setIdx] = useState(snapshots.length - 1)
  const snap = snapshots[Math.min(idx, snapshots.length - 1)]!
  const included = snap.items.filter((i) => i.included)
  const bySource = SOURCES.map((s) => ({ s, tokens: included.filter((i) => i.source === s).reduce((n, i) => n + i.tokens, 0) })).filter((x) => x.tokens > 0)
  const scale = Math.max(snap.budgetTokens, snap.totalTokens) * 1.06
  const over = snap.totalTokens > snap.budgetTokens
  const declared = snap.items.filter((i) => i.source === 'artifact' || i.source === 'knowledge')
  const notInjected = snap.items.filter((i) => !i.included)
  const runtimeReads = snap.items.filter((i) => i.source === 'tool_result')
  const labels = ['组装', '运行中', '压缩后']
  return (
    <div className="dpad">
      {snapshots.length > 1 && (
        <div className="d-toolbar">
          <div className="snap-tabs">
            {snapshots.map((s, i) => (
              <button key={i} className={`snap-tab${i === idx ? ' on' : ''}${s.totalTokens > s.budgetTokens ? ' over' : ''}`} onClick={() => setIdx(i)}>
                <span>{labels[i] ?? `快照 ${i + 1}`}</span>
                <span className="mono num">{fmtTokens(s.totalTokens)}</span>
                <span className="faint mono">{fmtTime(s.at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={`ctx-summary${over ? ' over' : ''}`}>
        <div className="ctx-total">
          <b className="mono num">{snap.totalTokens.toLocaleString()}</b>
          <span className="faint"> / {snap.budgetTokens.toLocaleString()} tokens</span>
          {over ? (
            <span className="ctx-flag">
              <TriangleAlert />
              超预算 {fmtTokens(snap.totalTokens - snap.budgetTokens)}
            </span>
          ) : (
            <span className="ctx-ok">预算内 · {Math.round((snap.totalTokens / snap.budgetTokens) * 100)}%</span>
          )}
        </div>
        <div className="ctx-bar">
          {bySource.map((x, i) => {
            // 段宽用 scaleX（动效规范：用量条不动画 width）：每段铺满整条、从自己的起点按比例缩放
            const start = bySource.slice(0, i).reduce((n, y) => n + y.tokens, 0) / scale
            return <span key={x.s} className="ctx-seg" style={{ left: `${start * 100}%`, transform: `scaleX(${x.tokens / scale})`, background: CONTEXT_SOURCE[x.s].color }} title={`${CONTEXT_SOURCE[x.s].label} ${fmtTokens(x.tokens)}`} />
          })}
          {bySource.slice(1).map((x, i) => (
            <span key={`sep-${x.s}`} className="ctx-sep" style={{ left: `${(bySource.slice(0, i + 1).reduce((n, y) => n + y.tokens, 0) / scale) * 100}%` }} aria-hidden />
          ))}
          {over && <span className="ctx-over" style={{ left: `${(snap.budgetTokens / scale) * 100}%`, width: `${((snap.totalTokens - snap.budgetTokens) / scale) * 100}%` }} />}
          <span className="ctx-budget" style={{ left: `${(snap.budgetTokens / scale) * 100}%` }}>
            <span>预算 {fmtTokens(snap.budgetTokens)}</span>
          </span>
        </div>
        <div className="ctx-legend">
          {bySource.map((x) => (
            <span key={x.s}>
              <i style={{ background: CONTEXT_SOURCE[x.s].color }} />
              {CONTEXT_SOURCE[x.s].label}
              <b className="mono num">{fmtTokens(x.tokens)}</b>
            </span>
          ))}
        </div>
      </div>

      <div className="plan-actual">
        <div>
          <label>计划读取</label>
          <b className="num">{declared.length}</b>
          <span className="faint">项产物 / 知识</span>
        </div>
        <div>
          <label>未注入</label>
          <b className="num" style={{ color: notInjected.length ? 'var(--st-waiting)' : undefined }}>{notInjected.length}</b>
          <span className="faint">项（预算 / 缺失 / 格式）</span>
        </div>
        <div>
          <label>运行中额外读取</label>
          <b className="num">{runtimeReads.length}</b>
          <span className="faint">项工具结果</span>
        </div>
      </div>

      <table className="table ctx-table">
        <thead>
          <tr>
            <th style={{ width: 92 }}>来源</th>
            <th>标题 / 引用</th>
            <th className="r" style={{ width: 70 }}>
              Token
            </th>
            <th style={{ width: 44 }}>注入</th>
          </tr>
        </thead>
        <tbody>
          {snap.items.map((i) => (
            <tr key={i.id} className={i.included ? undefined : 'excluded'}>
              <td>
                <span className="src-tag" style={{ '--src': CONTEXT_SOURCE[i.source].color } as CSSProperties}>
                  {CONTEXT_SOURCE[i.source].label}
                </span>
              </td>
              <td>
                <div className="truncate ctx-title">{i.title}</div>
                {(i.ref || i.reason) && (
                  <div className="ctx-ref truncate">
                    {i.ref && <span className="mono">{i.ref}</span>}
                    {i.reason && <span className="ctx-reason"> {i.reason}</span>}
                  </div>
                )}
              </td>
              <td className="r mono">{i.tokens ? fmtTokens(i.tokens) : '—'}</td>
              <td>{i.included ? <Check className="ok-icon" /> : <X className="no-icon" />}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="d-section">
        <div className="d-section-title">
          压缩记录 <span className="faint num">{compactions.length}</span>
        </div>
        {compactions.length === 0 ? (
          <p className="faint d-note">没有发生压缩。节点默认新会话，结论都落在存放区，压缩后续跑只认文件。</p>
        ) : (
          compactions.map((c, i) => {
            const max = c.beforeTokens
            return (
              <div key={i} className="compaction">
                <div className="compaction-head">
                  <Shrink />
                  <span className="mono">{fmtTime(c.at)}</span>
                  <span className="chip">{c.trigger === 'auto' ? '自动' : c.trigger === 'manual' ? '手动' : '策略'}</span>
                  <span style={{ flex: 1 }} />
                  <span className="compaction-drop num">−{Math.round((1 - c.afterTokens / c.beforeTokens) * 100)}%</span>
                </div>
                <div className="cmp-bars">
                  <div className="cmp-row">
                    <label>压缩前</label>
                    <span className="cmp-track">
                      <span style={{ width: '100%', background: 'var(--st-failed)' }} />
                    </span>
                    <b className="mono num">{fmtTokens(c.beforeTokens)}</b>
                  </div>
                  <div className="cmp-row">
                    <label>压缩后</label>
                    <span className="cmp-track">
                      <span style={{ width: `${(c.afterTokens / max) * 100}%`, background: 'var(--st-success)' }} />
                    </span>
                    <b className="mono num">{fmtTokens(c.afterTokens)}</b>
                  </div>
                </div>
                <p className="compaction-summary">{c.summary}</p>
                <div className="compaction-dropped">
                  <span className="faint">丢弃</span>
                  <ul>
                    {c.dropped.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ================================================================ 判决

function VerdictCard({ v, routedTo, runId, requirementId }: { v: JudgeVerdict; routedTo?: string; runId: string; requirementId: string }) {
  const meta = VERDICT[v.category]
  const target = routedTo && routedTo !== 'human' && routedTo !== 'ignore' ? `dev-test-loop/${routedTo}` : undefined
  return (
    <div className="verdict" style={{ '--v': meta.color } as CSSProperties}>
      <div className="verdict-head">
        <span className="mono verdict-subject">{v.subject}</span>
        <span className="verdict-cat">
          <span className="mono">{v.category}</span>
          {meta.label}
        </span>
        <span style={{ flex: 1 }} />
        <span className="verdict-conf">
          <span className="faint">置信度</span>
          <span className="verdict-conf-bar">
            <Meter value={v.confidence} tone={v.confidence >= 0.8 ? 'success' : v.confidence >= 0.6 ? 'waiting' : 'failed'} height={5} />
          </span>
          <b className="mono num">{Math.round(v.confidence * 100)}%</b>
        </span>
      </div>
      <p className="verdict-why">{v.rationale}</p>
      <div className="verdict-evidence">
        {v.evidence.map((e) => {
          const path = e.split(/[#:]/)[0]!
          const isWs = /^(evidence|cases|spec|design|reports|tasks)\//.test(path)
          return isWs ? (
            <Link key={e} className="chip mono" to={`/req/${requirementId}?path=${encodeURIComponent(path)}`}>
              {e}
            </Link>
          ) : (
            <span key={e} className="chip mono">
              {e}
            </span>
          )
        })}
      </div>
      <div className="verdict-foot">
        {v.fixScope && <span className={`fix-scope ${v.fixScope}`}>{v.fixScope === 'mechanical' ? '机械修复 · 可自动合入' : '语义修复 · 需人确认'}</span>}
        {v.fixHint && <span className="verdict-hint">提示：{v.fixHint}</span>}
        <span style={{ flex: 1 }} />
        {routedTo && (
          <span className="verdict-route">
            <ArrowRight />
            {target ? (
              <Link className="mono" to={`/run/${runId}?node=${encodeURIComponent(target)}`}>
                {routedTo}
              </Link>
            ) : (
              <span className="mono">{routedTo === 'human' ? '待办（人）' : '仅记录'}</span>
            )}
            <span className="faint">· {meta.owner}</span>
          </span>
        )}
      </div>
    </div>
  )
}

export function JudgeTab({ d, runId, requirementId }: { d: NodeDetail; runId: string; requirementId: string }) {
  const verdictEvents = eventsOf(d, 'judge.verdict')
  if (!verdictEvents.length)
    return (
      <div className="dpad">
        <EmptyState compact icon={Check} title="没有判决" body="上游执行节点没有失败用例时，判决节点直接成功、不调用模型。" />
      </div>
    )
  return (
    <div className="dpad">
      <p className="faint d-note" style={{ marginTop: 0 }}>
        权威顺序：需求 / spec &gt; 契约 &gt; 用例 &gt; 脚本 &gt; 代码。判决 Agent 只读，修复交给对应角色，修完再由独立执行节点验证。
      </p>
      {verdictEvents.map((ev) => (
        <div key={ev.seq} className="d-section first">
          <div className="d-section-title">
            {fmtDate(ev.ts)} · {ev.data.verdicts.length} 条判决
          </div>
          <div className="verdicts">
            {ev.data.verdicts.map((v) => (
              <VerdictCard key={v.subject} v={v} routedTo={ev.data.routed.find((r) => r.subject === v.subject)?.to} runId={runId} requirementId={requirementId} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ================================================================ 门禁

const CHECK_KIND: Record<string, string> = { rubric: 'rubric', command: '命令', function: '函数' }

export function GateTab({ d }: { d: NodeDetail }) {
  if (!d.gate) return <div className="dpad"><EmptyState compact icon={Check} title="门禁尚未执行" /></div>
  const g = d.gate
  return (
    <div className="dpad">
      <div className={`gate-banner ${g.pass ? 'pass' : 'fail'}`}>
        {g.pass ? <Check /> : <X />}
        <div>
          <b>{g.pass ? '门禁通过' : '门禁未通过'}</b>
          <div className="faint">fail-closed：检查本身出错按不通过处理 · {g.checks.filter((c) => c.pass).length}/{g.checks.length} 项通过</div>
        </div>
      </div>
      <div className="gate-checks">
        {g.checks.map((c) => {
          const def = d.checks?.find((x) => x.id === c.id)
          return (
            <div key={c.id} className={`gate-check ${c.pass ? 'pass' : 'fail'}`}>
              <span className="gate-icon">{c.pass ? <Check /> : <X />}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="gate-check-head">
                  <span className="truncate">{def?.title ?? <span className="mono">{c.id}</span>}</span>
                  {def && <span className="gate-kind">{CHECK_KIND[def.kind] ?? def.kind}</span>}
                </div>
                {def?.title && <div className="gate-check-id mono">{c.id}</div>}
                {c.score !== undefined && <GateScore score={c.score} pass={c.pass} threshold={def?.threshold} />}
                {c.message && <p className="gate-msg">{c.message}</p>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 分数条：0–100 轨道，阈值处画竖线，阈值右侧是通过区。没有阈值（旧 server）时只画分数。 */
function GateScore({ score, pass, threshold }: { score: number; pass: boolean; threshold?: number }) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v))
  const delta = threshold === undefined ? undefined : score - threshold
  return (
    <div className={`gate-score ${pass ? 'pass' : 'fail'}`}>
      <div className="gate-score-nums">
        <b className="mono num">{score}</b>
        <span className="faint">/ 100</span>
        {delta !== undefined && (
          <span className="gate-delta mono num" title={`与阈值 ${threshold} 的差`}>
            {delta >= 0 ? `+${delta}` : `−${-delta}`}
          </span>
        )}
      </div>
      <div className="gate-score-track" role="img" aria-label={threshold === undefined ? `得分 ${score}` : `得分 ${score}，阈值 ${threshold}`}>
        {threshold !== undefined && <span className="gate-pass-zone" style={{ left: `${clamp(threshold)}%` }} />}
        <span className="gate-score-fill" style={{ transform: `scaleX(${clamp(score) / 100})` }} />
        {threshold !== undefined && (
          <span className="gate-threshold" style={{ left: `${clamp(threshold)}%` }}>
            <span className="gate-threshold-label">
              阈值 <b className="mono num">{threshold}</b>
            </span>
          </span>
        )}
      </div>
    </div>
  )
}

// ================================================================ Prompt

export function PromptTab({ d }: { d: NodeDetail }) {
  const text = d.prompt ?? ''
  const lines = useMemo(() => text.split('\n'), [text])
  return (
    <div className="dpad">
      <div className="d-toolbar">
        <span className="faint">
          实际发送的 prompt（渲染后）· {lines.length} 行 · 约 <span className="mono">{fmtTokens(Math.round(text.length / 2.2))}</span> tokens
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast('已复制 prompt'))}>
          <Copy />
          复制
        </button>
      </div>
      <pre className="prompt-view">
        {lines.map((l, i) => (
          <span key={i} className="prompt-line">
            <span className="prompt-ln">{i + 1}</span>
            <span className={l.startsWith('#') ? 'prompt-h' : l.startsWith('- ') ? 'prompt-li' : undefined}>{l || ' '}</span>
          </span>
        ))}
      </pre>
    </div>
  )
}
