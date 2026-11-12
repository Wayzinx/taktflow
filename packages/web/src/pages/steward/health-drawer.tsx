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

/** 指标键 → 人话（服务端 steward/metrics.ts 的 metric 键）；原始键放在悬停提示里。 */
const METRIC: Record<string, string> = {
  completion_ms: '填写到提交的用时',
  submissions: '提交数',
  submit_rate: '打开后提交的比例',
  started_within_5m: '5 分钟内开始运行',
  route_override: '人工改流程的比例',
  criteria_adopted: '验收标准建议采纳率',
  first_token_ms: '首字延迟',
  tools_avg: '每次回答调用工具数',
  citation_coverage: '事实带来源的比例',
  tool_error_rate: '工具出错率',
  down_rate: '点踩比例',
  down_wrong: '点踩：答错了',
  down_missed: '点踩：没答到点',
  down_verbose: '点踩：太啰嗦',
  down_bad_action: '点踩：操作不对',
  applied_rate: '批准执行的比例',
  edited_rate: '改过再批准的比例',
  rejected_rate: '被拒绝的比例',
  failed_rate: '执行失败的比例',
  reverted_rate: '执行后撤销的比例',
  decision_ms: '从提案到决定的用时',
  click_rate: '汇报点击率',
  snoozed_rate: '风险被推迟的比例',
  ignored_rate: '风险被忽略的比例',
  resolution_ms: '风险处理用时',
  lint_error_rate: '保存后校验失败的比例',
  conflict_rate: '保存冲突的比例',
  template_blank: '选空白模板的比例',
  template_standard: '选标准模板的比例',
  template_quick: '选快速模板的比例',
  first_requirement_ms: '建空间到第一个需求的用时',
  hit_rate: '检索有结果的比例',
  recall10: '召回率（前 10 条）',
  citation_rate: '检索结果被引用的比例',
}
/** 带前缀的键：config.patch.applied_rate → 「config.patch · 批准执行的比例」，waiting-human.resolution_rate → 该类风险提醒后处理的比例。 */
function metricLabel(key: string): string {
  if (METRIC[key]) return METRIC[key]
  const dot = key.lastIndexOf('.')
  const scope = key.slice(0, dot), base = key.slice(dot + 1)
  if (dot > 0 && base === 'resolution_rate') return `${scope} 风险提醒后处理的比例`
  if (dot > 0 && METRIC[base]) return `${scope} · ${METRIC[base]}`
  return key
}
/** 有明确目标线的指标：超出时数字标红。 */
const TARGET: Record<string, { max?: number; min?: number; text: string }> = {
  first_token_ms: { max: 5000, text: '目标 < 5 秒' },
  citation_coverage: { min: 80, text: '目标 ≥ 80%' },
  tool_error_rate: { max: 10, text: '目标 ≤ 10%' },
  down_rate: { max: 20, text: '目标 ≤ 20%' },
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
  // 没有样本时 0 / 0% 是假数（比例的分母为 0）：显示「—」
  const empty = m.samples === 0
  const first = m.trend?.[0]
  const delta = first !== undefined && !empty ? m.value - first : undefined
  const target = TARGET[m.metric]
  const bad = !empty && !!target && ((target.max !== undefined && m.value > target.max) || (target.min !== undefined && m.value < target.min))
  return (
    <li className={`stwp-metric ${className ?? ''}`} style={style} data-bad={bad || undefined}>
      <div className="stwp-metric-top">
        <span className="stwp-metric-name" title={m.metric}>{metricLabel(m.metric)}</span>
        <span className="faint">{target ? `${target.text} · ` : ''}{m.window}</span>
      </div>
      <div className="stwp-metric-mid">
        {empty ? <span className="stwp-metric-value faint" title="还没有样本">—</span> : <CountUp className="stwp-metric-value" value={m.value} format={fmt(m)} />}
        {delta !== undefined && delta !== 0 && (
          <span className="faint num">
            {delta > 0 ? '+' : ''}
            {fmt(m)(delta)} / 7 天
          </span>
        )}
        <span style={{ flex: 1 }} />
        {m.trend && !empty && <Spark data={m.trend} />}
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
