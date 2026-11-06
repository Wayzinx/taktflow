import { useState } from 'react'
import { ArrowDown, ArrowUp, BarChart3, TrendingDown } from 'lucide-react'
import type { NodeScorecard, VerdictCategory } from '@taktflow/core'
import { EmptyState, SkeletonRows } from '../../components/ui'
import { fmtCost, fmtTokens, totalTokens } from '../../lib/format'
import { VERDICT, VERDICT_ORDER } from '../../lib/status'
import { cardKey, cardTitle, pct } from './labels'
import { Sparkline } from './sparkline'

export { cardKey }

type SortKey = 'executions' | 'firstPassRate' | 'escapes' | 'detection' | 'cost' | 'none'
const sortValue = (c: NodeScorecard, k: SortKey): number =>
  k === 'executions' ? c.executions : k === 'firstPassRate' ? (c.firstPassRate ?? -1) : k === 'escapes' ? c.escapes : k === 'detection' ? (c.detection?.rate ?? -1) : k === 'cost' ? (c.usage.costUsd ?? 0) : 0

export function Downstream({ d }: { d: NodeScorecard['downstream'] }) {
  const items = VERDICT_ORDER.filter((k) => (d[k] ?? 0) > 0) as VerdictCategory[]
  if (items.length === 0) return <span className="faint">—</span>
  return (
    <span className="sc-down">
      {items.map((k) => (
        <span key={k} className="sc-down-item" title={`${VERDICT[k].label} → ${VERDICT[k].owner}`}>
          <i style={{ background: VERDICT[k].color }} aria-hidden />
          {VERDICT[k].label} <b className="num">{d[k]}</b>
        </span>
      ))}
    </span>
  )
}

export function RegressionTag({ c, compact }: { c: NodeScorecard; compact?: boolean }) {
  if (!c.regression?.suspected) return null
  return (
    <span className="sc-regress" title={c.regression.reason}>
      <TrendingDown aria-hidden />
      {compact ? '退化' : '疑似退化'}
    </span>
  )
}

export function ScorecardTable({ cards, by, onOpen }: { cards?: NodeScorecard[]; by: NodeScorecard['key']['by']; onOpen: (key: string) => void }) {
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'none', desc: true })
  if (!cards) return <SkeletonRows rows={8} />
  if (cards.length === 0) return <EmptyState compact icon={BarChart3} title="还没有成绩单" hint="节点执行过、记下配方之后，这里会按节点 / 配方 / 技能聚合出指标。" />
  const rows = sort.k === 'none' ? cards : [...cards].sort((a, b) => (sortValue(a, sort.k) - sortValue(b, sort.k)) * (sort.desc ? -1 : 1))
  const Th = ({ k, children, title }: { k: SortKey; children: string; title?: string }) => (
    <th className="r" aria-sort={sort.k === k ? (sort.desc ? 'descending' : 'ascending') : undefined} title={title}>
      <button className="sc-sort" onClick={() => setSort((s) => (s.k === k ? (s.desc ? { k, desc: false } : { k: 'none', desc: true }) : { k, desc: true }))}>
        {children}
        {sort.k === k && (sort.desc ? <ArrowDown aria-hidden /> : <ArrowUp aria-hidden />)}
      </button>
    </th>
  )
  const first = by === 'skill' ? '技能版本' : by === 'recipe' ? '节点 · 配方' : '节点'
  return (
    <div className="sc-wrap">
      <table className="table sc-table">
        <thead>
          <tr>
            <th>{first}</th>
            <Th k="executions">执行</Th>
            <Th k="firstPassRate" title="第一次执行就成功且完成标准全部满足">一次通过率</Th>
            <th title="评审轮数均值 · 打回次数 · blocker / major 问题">评审负担</th>
            <th title="人修改产物：语义 / 措辞">人工改写</th>
            <th className="r" title="完成标准未满足次数">未满足</th>
            <th className="r" title="失败指纹抑制次数">抑制</th>
            <th>下游判决</th>
            <Th k="escapes" title="已确认归因到该节点引入的逃逸缺陷">逃逸</Th>
            <Th k="detection" title="拦下 ÷（拦下 + 确认漏检）">检出率</Th>
            <Th k="cost">成本</Th>
            <th>配方趋势</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const k = cardKey(c)
            const name = cardTitle(c)
            const low = c.detection?.rate !== undefined && c.detection.rate < 0.7
            return (
              <tr key={k} className="clickable" onClick={() => onOpen(k)}>
                <td className="sc-name">
                  <button className="sc-name-btn" onClick={(e) => (e.stopPropagation(), onOpen(k))}>
                    <span className="truncate" title={c.label}>{name.title}</span>
                    <RegressionTag c={c} compact />
                  </button>
                  <span className="sc-sub mono truncate">
                    {name.sub}
                  </span>
                </td>
                <td className="r num">{c.executions}</td>
                <td className={`r num${c.regression?.suspected ? ' sc-bad' : ''}`}>{pct(c.firstPassRate)}</td>
                <td className="sc-meta">
                  {c.review.roundsAvg !== undefined ? <span className="num">{c.review.roundsAvg.toFixed(1)} 轮</span> : <span className="faint">—</span>}
                  {c.review.reworks > 0 && <span className="num"> · 打回 {c.review.reworks}</span>}
                  {(c.review.issues.blocker > 0 || c.review.issues.major > 0) && (
                    <span className="sc-sub num">
                      B{c.review.issues.blocker} · M{c.review.issues.major}
                    </span>
                  )}
                </td>
                <td className="sc-meta">
                  {c.humanEdits.semantic + c.humanEdits.cosmetic === 0 ? (
                    <span className="faint">—</span>
                  ) : (
                    <>
                      <span className="num">语义 {c.humanEdits.semantic} · 措辞 {c.humanEdits.cosmetic}</span>
                      {c.humanEdits.rate !== undefined && <span className="sc-sub num">{pct(c.humanEdits.rate)} 被改</span>}
                    </>
                  )}
                </td>
                <td className="r num">{c.completionUnmet || <span className="faint">0</span>}</td>
                <td className="r num">{c.suppressed || <span className="faint">0</span>}</td>
                <td>
                  <Downstream d={c.downstream} />
                </td>
                <td className={`r num${c.escapes > 0 ? ' sc-bad' : ''}`}>{c.escapes || <span className="faint">0</span>}</td>
                <td className={`r num${low ? ' sc-warn' : ''}`}>
                  {c.detection ? (
                    <>
                      {pct(c.detection.rate)}
                      <span className="sc-sub num">
                        {c.detection.caught} / {c.detection.caught + c.detection.missed}
                      </span>
                    </>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="r num">
                  {fmtCost(c.usage.costUsd)}
                  <span className="sc-sub num">{fmtTokens(totalTokens(c.usage))}</span>
                </td>
                <td>
                  <Sparkline trend={c.trend} regressed={c.regression?.suspected} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
