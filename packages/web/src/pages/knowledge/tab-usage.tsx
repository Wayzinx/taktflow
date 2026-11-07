import type { CSSProperties } from 'react'
import type { KnowledgeBaseDetail } from '@taktflow/core'
import { Activity, CircleCheck, CircleMinus } from 'lucide-react'
import { CountUp, EmptyState, useStagger } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { Link, setQuery } from '../../lib/router'
import { pct } from './meta'

/** 使用：哪些 workflow / 节点 / 需求查过它，引用率，最近的查询。 */
export function UsageTab({ base }: { base: KnowledgeBaseDetail }) {
  const { byNode, recent } = base.usage
  const st = useStagger(recent.length)
  if (!byNode.length && !recent.length)
    return <EmptyState icon={Activity} title="还没有被用过" body="发布并绑定后，节点在运行里查它的记录会出现在这里。" action={<Link to="/settings?tab=knowledge" className="btn btn-primary">去绑定</Link>} stewardAsk={`知识库「${base.name}」应该给哪些节点用？帮我配上`} />
  const total = byNode.reduce((n, x) => n + x.queries, 0)
  return (
    <div className="kb-usage">
      <div className="kb-kpis kb-kpis-3">
        <div className="kb-kpi">
          <span className="kb-kpi-k">7 天查询</span>
          <span className="kb-kpi-v num"><CountUp value={base.usage7d.queries} /></span>
        </div>
        <div className="kb-kpi">
          <span className="kb-kpi-k">引用率</span>
          <span className="kb-kpi-v num"><CountUp value={base.usage7d.citedRate} format={(v) => pct(v)} /></span>
          <span className="kb-kpi-hint">命中内容被产物引用的比例</span>
        </div>
        <div className="kb-kpi">
          <span className="kb-kpi-k">用到它的节点</span>
          <span className="kb-kpi-v num"><CountUp value={byNode.length} /></span>
        </div>
      </div>
      <div className="kb-cols">
        <section className="kb-section">
          <h2 className="kb-h2">按节点</h2>
          <table className="table">
            <thead>
              <tr>
                <th>workflow · 节点</th>
                <th className="r">查询</th>
                <th>引用率</th>
              </tr>
            </thead>
            <tbody>
              {byNode.map((n) => (
                <tr key={`${n.workflowId}/${n.nodeId}`}>
                  <td>
                    <Link to={`/workflows/${n.workflowId}`} className="mono kb-link">
                      {n.workflowId}
                    </Link>
                    <span className="faint"> · </span>
                    <span className="mono">{n.nodeId}</span>
                  </td>
                  <td className="r num">
                    {n.queries.toLocaleString()} <span className="faint">({pct(n.queries / Math.max(1, total))})</span>
                  </td>
                  <td>
                    <span className="kb-meter-cell">
                      <span className="meter" data-tone="success" style={{ '--meter': n.citedRate } as CSSProperties}>
                        <span className="meter-fill" />
                      </span>
                      <span className="num">{pct(n.citedRate)}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="kb-section">
          <h2 className="kb-h2">最近的查询</h2>
          <ul className="kb-recent">
            {recent.map((r, i) => {
              const s = st(i)
              return (
                <li key={`${r.at}-${i}`} className={s.className} style={s.style}>
                  {r.cited ? <CircleCheck className="kb-ok" aria-label="被引用" /> : <CircleMinus className="kb-miss" aria-label="没被引用" />}
                  <div className="kb-recent-main">
                    <button type="button" className="kb-recent-q truncate" title="在检索测试里重跑这个问题" onClick={() => setQuery({ tab: 'query', q: r.query })}>
                      {r.query}
                    </button>
                    <span className="faint kb-recent-meta">
                      {r.requirementId && (
                        <Link to={`/req/${r.requirementId}`} className="mono kb-link">
                          {r.requirementId}
                        </Link>
                      )}
                      {r.nodeId && <span className="mono">{r.nodeId}</span>}
                      <span>{r.via === 'prefetch' ? '预取' : '工具调用'}</span>
                      <span>{fmtRelative(r.at)}</span>
                    </span>
                  </div>
                  <span className={`num ${r.hits ? '' : 'kb-zero'}`}>{r.hits} 条</span>
                  <span className="faint num">{r.latencyMs}ms</span>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </div>
  )
}
