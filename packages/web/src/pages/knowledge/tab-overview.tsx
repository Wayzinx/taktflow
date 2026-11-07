import type { CSSProperties, ReactNode } from 'react'
import type { KnowledgeBaseDetail, KnowledgeBuild } from '@taktflow/core'
import { AlertTriangle, CircleCheck, Clock, Link2, SearchX, Unplug } from 'lucide-react'
import { CountUp, EmptyState, SuggestionChips } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { Link, setQuery } from '../../lib/router'
import { BuildProgress } from './build-progress'
import { intentLabel, pct, scaleText } from './meta'

function Stat({ label, value, format, hint, tone }: { label: string; value: number | undefined; format: (v: number) => string; hint?: string; tone?: string }) {
  return (
    <div className="kb-kpi" data-tone={tone}>
      <span className="kb-kpi-k">{label}</span>
      <span className="kb-kpi-v num">{value === undefined ? '—' : <CountUp value={value} format={format} />}</span>
      {hint && <span className="kb-kpi-hint">{hint}</span>}
    </div>
  )
}

function Health({ icon: Icon, tone, children, action }: { icon: typeof CircleCheck; tone: string; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="kb-health" data-tone={tone}>
      <Icon aria-hidden />
      <span className="kb-health-text">{children}</span>
      {action}
    </li>
  )
}

/** 7 天趋势：查询量柱 + 命中率读数。柱高是静态的（不对 height 做动画）。 */
function Trend({ trend }: { trend: KnowledgeBaseDetail['usage']['trend'] }) {
  const max = Math.max(1, ...trend.map((t) => t.queries))
  return (
    <div className="kb-trend" role="img" aria-label={`近 7 天查询量：${trend.map((t) => t.queries).join('、')}`}>
      {trend.map((t) => (
        <div key={t.date} className="kb-trend-col" title={`${t.date}：${t.queries} 次查询，命中率 ${pct(t.hitRate)}`}>
          <span className="kb-trend-v num">{t.queries}</span>
          <span className="kb-trend-bar" style={{ '--h': `${Math.max(4, (t.queries / max) * 100)}%` } as CSSProperties} />
          <span className="kb-trend-d num">{t.date.slice(5)}</span>
          <span className="kb-trend-hit num">{pct(t.hitRate)}</span>
        </div>
      ))}
    </div>
  )
}

export function OverviewTab({ base, live, onBuild }: { base: KnowledgeBaseDetail; live?: KnowledgeBuild; onBuild: () => void }) {
  const u = base.usage7d
  const has = u.queries > 0
  const recall = base.lastEval?.recall10
  const items: ReactNode[] = []
  if (base.status === 'error') items.push(<Health key="err" icon={AlertTriangle} tone="failed">{base.error ?? '上次构建出错'}</Health>)
  if (base.staleDocs) items.push(<Health key="stale" icon={Clock} tone="stale" action={<button type="button" className="btn btn-sm" onClick={onBuild}>重新构建</button>}>{base.staleDocs} 篇文档在构建之后又变了，运行查到的可能是旧内容。</Health>)
  if (has && u.emptyRate > 0.1) items.push(<Health key="empty" icon={SearchX} tone="waiting" action={<button type="button" className="btn btn-sm" onClick={() => setQuery({ tab: 'usage' })}>看失败查询</button>}>无结果率 {pct(u.emptyRate)}，偏高：可能缺文档或缺同义词。</Health>)
  if (recall !== undefined && recall < 0.8) items.push(<Health key="recall" icon={AlertTriangle} tone="waiting" action={<button type="button" className="btn btn-sm" onClick={() => setQuery({ tab: 'eval' })}>看评测</button>}>Recall@10 只有 {recall.toFixed(2)}，建议看逐用例诊断。</Health>)
  if (!base.bound) items.push(<Health key="bound" icon={Unplug} tone="skipped" action={<Link to="/settings?tab=knowledge" className="btn btn-sm">去绑定</Link>}>还没有绑定到本空间，运行时不会用到它。</Health>)
  if (!items.length) items.push(<Health key="ok" icon={CircleCheck} tone="success">一切正常：{scaleText(base)}，{base.builtAt ? `${fmtRelative(base.builtAt)}构建` : '还没有构建'}。</Health>)

  return (
    <div className="kb-overview">
      <div className="kb-kpis">
        <Stat label="7 天查询" value={has ? u.queries : undefined} format={(v) => Math.round(v).toLocaleString()} />
        <Stat label="命中率" value={has ? u.hitRate : undefined} format={(v) => pct(v)} hint="top k 里至少一条相关" />
        <Stat label="引用率" value={has ? u.citedRate : undefined} format={(v) => pct(v)} hint="命中被产物引用" />
        <Stat label="无结果率" value={has ? u.emptyRate : undefined} format={(v) => pct(v)} tone={has && u.emptyRate > 0.1 ? 'waiting' : undefined} />
        <Stat label="Recall@10" value={recall} format={(v) => v.toFixed(2)} hint={base.lastEval ? `${fmtRelative(base.lastEval.at)}评测` : '还没有评测'} tone={recall === undefined ? undefined : recall >= 0.85 ? 'success' : recall >= 0.75 ? 'waiting' : 'failed'} />
      </div>

      {live?.status === 'running' && (
        <section className="kb-section">
          <div className="kb-section-head">
            <h2 className="kb-h2">正在构建</h2>
            <button type="button" className="kb-link" onClick={() => setQuery({ tab: 'builds' })}>
              看日志
            </button>
          </div>
          <BuildProgress build={live} showLog={false} />
        </section>
      )}

      <div className="kb-cols">
        <section className="kb-section">
          <h2 className="kb-h2">健康</h2>
          <ul className="kb-health-list">{items}</ul>
          {items.length > 1 && <SuggestionChips items={[`帮我优化知识库「${base.name}」的召回`]} context={[{ type: 'knowledge', id: base.id, label: base.name }]} />}
        </section>
        <section className="kb-section">
          <div className="kb-section-head">
            <h2 className="kb-h2">使用趋势</h2>
            <span className="faint">近 7 天</span>
          </div>
          {has ? <Trend trend={base.usage.trend} /> : <EmptyState compact icon={SearchX} title="还没有被查询过" body="发布并绑定到空间后，运行里的节点就会查它。" action={<button type="button" className="btn btn-sm" onClick={() => setQuery({ tab: 'query' })}>先试试检索</button>} />}
        </section>
      </div>

      <section className="kb-section">
        <div className="kb-section-head">
          <h2 className="kb-h2">绑定</h2>
          <Link to="/settings?tab=knowledge" className="kb-link">
            在空间设置里管理
          </Link>
        </div>
        {base.bindings.length === 0 ? (
          <EmptyState compact icon={Link2} title="没有空间绑定它" body="绑定后，路由器才会按问题意图选到它。" action={<Link to="/settings?tab=knowledge" className="btn btn-sm btn-primary">去绑定</Link>} />
        ) : (
          <ul className="kb-bind-list">
            {base.bindings.map((x) => (
              <li key={x.spaceId}>
                <span className="mono">{x.spaceId}</span>
                <span className={`kb-tag${x.enabled ? '' : ' quiet'}`} data-tone={x.enabled ? 'success' : undefined}>
                  {x.enabled ? '启用' : '停用'}
                </span>
                <span className="faint">优先级 {x.priority}</span>
                <span className="faint">{(x.intents ?? base.intents).map(intentLabel).join('、')}</span>
                {x.roles?.length ? <span className="faint">仅 {x.roles.join('、')}</span> : <span className="faint">所有角色</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
