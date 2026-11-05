import type { CSSProperties, ReactNode } from 'react'
import type { GraphNode, Usage } from '@taktflow/core'
import { useAsync } from '../../api'
import { ErrorState, Skeleton } from '../../components/ui'
import { fmtCost, fmtPct, fmtTokens, totalTokens } from '../../lib/format'
import { NODE_KIND, VERDICT, VERDICT_ORDER } from '../../lib/status'

function Ring({ value }: { value?: number }) {
  const r = 22
  const c = 2 * Math.PI * r
  const v = value ?? 0
  return (
    <svg width="48" height="48" viewBox="0 0 56 56" className="ring" aria-hidden>
      <circle cx="28" cy="28" r={r} fill="none" stroke="var(--bg-sunken)" strokeWidth="6" />
      <circle cx="28" cy="28" r={r} fill="none" stroke={v >= 0.6 ? 'var(--st-success)' : v >= 0.35 ? 'var(--st-waiting)' : 'var(--st-failed)'} strokeWidth="6" strokeLinecap="butt" strokeDasharray={`${c * v} ${c}`} transform="rotate(-90 28 28)" />
    </svg>
  )
}

function Kpi({ label, value, hint, visual }: { label: string; value: ReactNode; hint: ReactNode; visual?: ReactNode }) {
  return (
    <div className="kpi">
      <div style={{ minWidth: 0 }}>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value num">{value}</div>
        <div className="kpi-hint">{hint}</div>
      </div>
      {visual}
    </div>
  )
}

interface Bar {
  key: string
  label: ReactNode
  value: number
  color: string
  extra?: ReactNode
}

function Bars({ bars, format }: { bars: Bar[]; format: (n: number) => string }) {
  const max = Math.max(1, ...bars.map((b) => b.value))
  return (
    <div className="hbars">
      {bars.map((b) => (
        <div key={b.key} className={`hbar${b.value === 0 ? ' zero' : ''}`}>
          <span className="hbar-label">{b.label}</span>
          <span className="hbar-track">
            <span style={{ width: `${(b.value / max) * 100}%`, background: b.color } as CSSProperties} />
          </span>
          <span className="hbar-value mono num">{format(b.value)}</span>
          {b.extra !== undefined && <span className="hbar-extra">{b.extra}</span>}
        </div>
      ))}
    </div>
  )
}

const ROLE_COLORS = ['var(--c-1)', 'var(--c-2)', 'var(--c-3)', 'var(--c-4)', 'var(--c-6)', 'var(--c-5)', 'var(--c-7)']
const ROLE_LABEL: Record<string, string> = { pm: '产品 pm', architect: '架构 architect', 'test-designer': '测试设计', automation: '自动化', dev: '开发 dev', reviewer: '评审 reviewer', judge: '判决 judge', 'kind:gate': '门禁 rubric' }

/** 没有角色的节点按类型归桶（门禁的 rubric 评审、planner 展开的子流程节点等），不混成一类。 */
const roleKey = (n: GraphNode) => n.role ?? `kind:${n.kind}`
const roleLabel = (k: string) => ROLE_LABEL[k] ?? (k.startsWith('kind:') ? `${NODE_KIND[k.slice(5) as GraphNode['kind']]?.label ?? k.slice(5)}（未标角色）` : k)

function sumBy(nodes: GraphNode[], key: (n: GraphNode) => string | undefined): Array<[string, Usage]> {
  const m = new Map<string, Usage>()
  for (const n of nodes) {
    if (!n.usage) continue
    const k = key(n)
    if (k === undefined) continue
    const u = m.get(k) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    m.set(k, { inputTokens: u.inputTokens + n.usage.inputTokens, outputTokens: u.outputTokens + n.usage.outputTokens, costUsd: (u.costUsd ?? 0) + (n.usage.costUsd ?? 0) })
  }
  return [...m.entries()].sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
}

export function MetricsTab({ id }: { id: string }) {
  const q = useAsync(async (ds) => {
    const [metrics, runs] = await Promise.all([ds.metrics(id), ds.runs(id)])
    const details = await Promise.all(runs.map((r) => ds.run(r.runId)))
    return { metrics, nodes: details.flatMap((d) => d.graph.nodes) }
  }, [id])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data)
    return (
      <div className="kpis">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="card kpi">
            <div>
              <Skeleton w={70} h={11} />
              <Skeleton w={50} h={22} style={{ marginTop: 12 }} />
            </div>
          </div>
        ))}
      </div>
    )
  const { metrics: m, nodes } = q.data
  const verdictTotal = Object.values(m.verdicts).reduce((s, n) => s + (n ?? 0), 0)
  const byRole = sumBy(nodes, roleKey)
  const byHarness = sumBy(nodes, (n) => n.harness)
  const tokens = totalTokens(m.usage)
  // 拆分只能按运行图节点的 usage 汇总，和需求级 usage 可能对不上（不是每次调用都落到节点上），占比按节点合计算
  const nodeTokens = byRole.reduce((s, [, u]) => s + totalTokens(u), 0)
  const harnessTokens = byHarness.reduce((s, [, u]) => s + totalTokens(u), 0)
  return (
    <div className="metrics">
      <div className="kpis">
        <Kpi label="首跑可用率" value={fmtPct(m.firstPassRate)} hint="首轮执行就通过的用例占比" visual={m.firstPassRate !== undefined ? <Ring value={m.firstPassRate} /> : undefined} />
        <Kpi label="Loop 轮次" value={m.loopIterations} hint="研发测试 Loop 累计迭代次数" />
        <Kpi label="人工介入" value={m.humanInterventions} hint="审批、回答、门禁放行、判决交人" />
        <Kpi label="交付周期" value={m.leadTimeHours !== undefined ? <>{m.leadTimeHours.toFixed(1)}<span className="kpi-unit">h</span></> : '—'} hint="需求创建到准出" />
        <Kpi label="Token / 成本" value={fmtTokens(tokens)} hint={<>{fmtCost(m.usage.costUsd)} · {m.runs} 次运行</>} />
      </div>
      <div className="metrics-grid">
        <section className="card">
          <div className="card-head">
            <span className="card-title">判决分布</span>
            <span className="faint num">{verdictTotal} 条</span>
            <span className="spacer" />
            <span className="faint" style={{ fontSize: 12 }}>哪类失败最多，就先治哪类的上游</span>
          </div>
          <div className="card-pad">
            <Bars
              format={(n) => String(n)}
              bars={VERDICT_ORDER.map((c) => ({
                key: c,
                label: (
                  <>
                    <span className="mono hbar-key">{c}</span>
                    {VERDICT[c].label}
                  </>
                ),
                value: m.verdicts[c] ?? 0,
                color: VERDICT[c].color,
                extra: <span className="faint">→ {VERDICT[c].owner}</span>,
              }))}
            />
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <span className="card-title">Token 按角色</span>
            <span className="spacer" />
            <span className="faint num" style={{ fontSize: 12 }} title={nodeTokens !== tokens ? `需求合计 ${fmtTokens(tokens)}，其中 ${fmtTokens(nodeTokens)} 能归到运行图节点` : undefined}>
              {nodeTokens !== tokens ? `节点合计 ${fmtTokens(nodeTokens)} / ${fmtTokens(tokens)}` : fmtTokens(tokens)}
            </span>
          </div>
          <div className="card-pad">
            {byRole.length === 0 && <p className="faint metrics-empty">运行图节点还没有 usage 记录。</p>}
            <Bars format={fmtTokens} bars={byRole.map(([k, u], i) => ({ key: k, label: roleLabel(k), value: totalTokens(u), color: ROLE_COLORS[i % ROLE_COLORS.length]!, extra: <span className="faint mono">{fmtCost(u.costUsd)}</span> }))} />
          </div>
          <div className="card-head" style={{ borderTop: '1px solid var(--divider)' }}>
            <span className="card-title">按 harness</span>
          </div>
          <div className="card-pad">
            {byHarness.length === 0 ? (
              <p className="faint metrics-empty">运行图节点没有记录 harness，暂时无法按 harness 拆分。</p>
            ) : (
            <>
            <div className="stack-bar">
              {byHarness.map(([k, u], i) => (
                <span key={k} style={{ flex: totalTokens(u), background: ROLE_COLORS[(i * 3) % ROLE_COLORS.length] }} title={`${k} ${fmtTokens(totalTokens(u))}`} />
              ))}
            </div>
            <div className="stack-legend">
              {byHarness.map(([k, u], i) => (
                <span key={k}>
                  <i style={{ background: ROLE_COLORS[(i * 3) % ROLE_COLORS.length] }} />
                  <span className="mono">{k}</span>
                  <b className="mono num">{fmtTokens(totalTokens(u))}</b>
                  <span className="faint num">{harnessTokens ? Math.round((totalTokens(u) / harnessTokens) * 100) : 0}%</span>
                </span>
              ))}
            </div>
            </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
