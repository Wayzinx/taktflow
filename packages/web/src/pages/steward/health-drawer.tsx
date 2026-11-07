import type { CSSProperties } from 'react'
import { Activity, Lightbulb } from 'lucide-react'
import type { ProductMetric } from '@taktflow/core'
import { useAsync } from '../../api'
import { CountUp, Drawer, EmptyState, ErrorState, SkeletonCard, useStagger } from '../../components/ui'
import { askSteward } from '../../lib/ui-store'

const FEATURE: Record<string, string> = {
  'requirement.create': '新建需求',
  'steward.answer': '管家回答',
  'steward.proposal': '变更提案',
  'steward.digest': '主动汇报',
  'workflow.edit': 'workflow 编辑',
  'space.create': '新建空间',
  knowledge: '知识库',
}

const fmt = (m: ProductMetric) => (v: number) => {
  const n = m.unit === 'ms' || m.unit === 'count' || m.unit === 's' ? Math.round(v).toLocaleString() : `${Math.round(v)}`
  return m.unit === '%' ? `${n}%` : m.unit === 'ms' ? `${n}ms` : m.unit === 's' ? `${n} 秒` : n
}

/** 7 天趋势小折线：只画形状，最后一点加圆点；不随数据重绘做动画。 */
function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null
  const w = 96
  const h = 28
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pts = data.map((v, i) => [(i / (data.length - 1)) * (w - 4) + 2, h - 3 - ((v - min) / span) * (h - 6)] as const)
  const last = pts[pts.length - 1]!
  return (
    <svg className="stwp-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} />
      <circle cx={last[0]} cy={last[1]} r={2.5} />
    </svg>
  )
}

function MetricRow({ m, style, className }: { m: ProductMetric; style?: CSSProperties; className?: string }) {
  const first = m.trend?.[0]
  const delta = first !== undefined ? m.value - first : undefined
  return (
    <li className={`stwp-metric ${className ?? ''}`} style={style}>
      <div className="stwp-metric-top">
        <span className="stwp-metric-name">{m.metric}</span>
        <span className="faint">{m.window}</span>
      </div>
      <div className="stwp-metric-mid">
        <CountUp className="stwp-metric-value" value={m.value} format={fmt(m)} />
        {delta !== undefined && delta !== 0 && (
          <span className="faint num">
            {delta > 0 ? '+' : ''}
            {fmt(m)(delta)} / 7 天
          </span>
        )}
        <span style={{ flex: 1 }} />
        {m.trend && <Spark data={m.trend} />}
      </div>
      {m.hint && (
        <button type="button" className="stwp-metric-hint pressable" title="让管家据此提一个改进" onClick={() => askSteward(`根据这个信号提一个改进：${m.hint}`)}>
          <Lightbulb aria-hidden />
          <span>{m.hint}</span>
        </button>
      )}
    </li>
  )
}

/** 产品健康（docs/design/22 §5）：每个功能的效率指标 + 迭代信号；点信号让管家出改进方案。 */
export function HealthDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useAsync((ds) => (open ? ds.productMetrics() : Promise.resolve(undefined)), [open])
  const groups = new Map<string, ProductMetric[]>()
  for (const m of q.data ?? []) groups.set(m.feature, [...(groups.get(m.feature) ?? []), m])
  const st = useStagger(q.data?.length ?? 0)
  let idx = 0
  return (
    <Drawer open={open} onClose={onClose} title="产品健康" description="近 7 天每个功能用得顺不顺，以及下一步该改什么" width={520}>
      <div className="stwp-drawer-body">
        {q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={q.reload} compact />
        ) : !q.data ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <SkeletonCard height={120} />
            <SkeletonCard height={120} />
            <SkeletonCard height={120} />
          </div>
        ) : q.data.length === 0 ? (
          <EmptyState compact icon={Activity} title="还没有数据" body="用几天之后，这里会显示每个功能的效率和改进信号" />
        ) : (
          [...groups].map(([feature, list]) => (
            <section key={feature} className="stwp-health-sec">
              <h3 className="section-label">{FEATURE[feature] ?? feature}</h3>
              <ul className="stwp-metrics">
                {list.map((m) => {
                  const s = st(idx++)
                  return <MetricRow key={m.metric} m={m} className={s.className} style={s.style} />
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </Drawer>
  )
}
