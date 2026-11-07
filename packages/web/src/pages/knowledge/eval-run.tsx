import { useMemo, useState } from 'react'
import type { KnowledgeEvalCase, KnowledgeEvalMetrics, KnowledgeEvalRun, KnowledgeEvalVariant, KnowledgeMissDiagnosis } from '@taktflow/core'
import { ArrowDown, ArrowUp, FilePlus2, Wand2 } from 'lucide-react'
import { CountUp, Segmented, SkeletonGrid } from '../../components/ui'
import { setQuery } from '../../lib/router'
import { DIAGNOSIS } from './meta'

type MetricKey = keyof KnowledgeEvalMetrics
const METRICS: Array<{ k: MetricKey; label: string; lower?: boolean; fmt: (v: number) => string }> = [
  { k: 'recall10', label: 'Recall@10', fmt: (v) => v.toFixed(2) },
  { k: 'recall5', label: 'Recall@5', fmt: (v) => v.toFixed(2) },
  { k: 'mrr', label: 'MRR', fmt: (v) => v.toFixed(2) },
  { k: 'ndcg10', label: 'nDCG@10', fmt: (v) => v.toFixed(2) },
  { k: 'hitRate', label: '命中率', fmt: (v) => `${Math.round(v * 100)}%` },
  { k: 'emptyRate', label: '无结果率', lower: true, fmt: (v) => `${Math.round(v * 100)}%` },
  { k: 'latencyP95', label: 'p95 延迟', lower: true, fmt: (v) => `${Math.round(v)}ms` },
  { k: 'tokensPerQuery', label: '每次 tokens', lower: true, fmt: (v) => Math.round(v).toLocaleString() },
  { k: 'sqlSuccess', label: 'SQL 成功率', fmt: (v) => `${Math.round(v * 100)}%` },
  { k: 'resultAccuracy', label: '结果正确率', fmt: (v) => `${Math.round(v * 100)}%` },
  { k: 'blocked', label: '守卫拦截', lower: true, fmt: (v) => String(Math.round(v)) },
]
const VERDICT = {
  better: { label: '更好', tone: 'success', text: '候选版本显著更好，可以发布。' },
  worse: { label: '更差', tone: 'failed', text: '候选版本显著更差，发布会被门槛拦下。' },
  same: { label: '持平', tone: 'skipped', text: '两者没有显著差别。' },
  inconclusive: { label: '不确定', tone: 'waiting', text: '样本不够，结论不确定：多加几条用例再跑。' },
} as const

/** 一条诊断建议 → 参数变体（在评测集上跑对比再决定发布）。 */
export function variantFor(d: KnowledgeMissDiagnosis, base?: KnowledgeEvalVariant): KnowledgeEvalVariant | undefined {
  const id = `${d}-${Date.now().toString(36)}`
  if (d === 'not_retrieved') return { id, label: '提高 BM25 权重', version: base?.version, retrieval: { hybrid: { bm25: 0.6, vector: 0.4 } } }
  if (d === 'low_rank') return { id, label: '开启 rerank', version: base?.version, retrieval: { rerank: 'bge-reranker', minScore: 0.1 } }
  return undefined
}

function MetricCards({ run }: { run: KnowledgeEvalRun }) {
  const ids = run.variants.map((v) => v.id)
  const baseline = run.comparison?.baseline ?? ids[0]!
  const shown = METRICS.filter((m) => ids.some((id) => run.metrics[id]?.[m.k] !== undefined))
  return (
    <div className="kb-metrics">
      {shown.map((m) => {
        const b = run.metrics[baseline]?.[m.k]
        return (
          <div key={m.k} className="kb-metric">
            <span className="kb-kpi-k">{m.label}</span>
            {run.variants.map((v) => {
              const val = run.metrics[v.id]?.[m.k]
              const delta = val !== undefined && b !== undefined && v.id !== baseline ? val - b : undefined
              const good = delta === undefined || Math.abs(delta) < 1e-9 ? undefined : m.lower ? delta < 0 : delta > 0
              return (
                <div key={v.id} className="kb-metric-row">
                  <span className="faint truncate">{v.label}</span>
                  <span className="num kb-metric-v">{val === undefined ? '—' : <CountUp value={val} format={m.fmt} />}</span>
                  {good !== undefined && delta !== undefined && (
                    <span className="kb-delta num" data-good={good}>
                      {delta > 0 ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
                      {m.fmt(Math.abs(delta))}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export function RunResult({ run, cases, onVariant }: { run: KnowledgeEvalRun; cases: Record<string, KnowledgeEvalCase>; onVariant: (v: KnowledgeEvalVariant) => void }) {
  const focus = run.comparison?.candidate ?? run.variants[run.variants.length - 1]?.id
  const [diag, setDiag] = useState<'all' | KnowledgeMissDiagnosis>('all')
  const byCase = useMemo(() => {
    const m = new Map<string, KnowledgeEvalRun['perCase']>()
    for (const p of run.perCase) m.set(p.caseId, [...(m.get(p.caseId) ?? []), p])
    return [...m.entries()]
  }, [run.perCase])
  if (run.status === 'running')
    return (
      <div className="kb-run-live">
        <span className="shimmer-text">正在评测 {run.variants.map((v) => v.label).join(' 对比 ')}</span>
        <SkeletonGrid count={4} min={180} />
      </div>
    )
  if (run.status === 'failed') return <div className="kb-gate bad">评测失败：{run.error ?? '未知原因'}</div>
  const cmp = run.comparison
  const focusRows = run.perCase.filter((p) => p.variant === focus)
  const n = (d: KnowledgeMissDiagnosis) => focusRows.filter((p) => p.diagnosis === d).length
  const rows = byCase.filter(([, ps]) => diag === 'all' || ps.some((p) => p.variant === focus && p.diagnosis === diag))
  const label = (id: string) => run.variants.find((v) => v.id === id)?.label ?? id
  return (
    <div className="kb-run">
      {cmp && (
        <div className="kb-verdict" data-tone={VERDICT[cmp.verdict].tone}>
          <span className="kb-verdict-badge">{VERDICT[cmp.verdict].label}</span>
          <div>
            <strong>
              {label(cmp.candidate)} 对比 {label(cmp.baseline)}：Recall@10 <span className="num">{cmp.recall10Delta > 0 ? '+' : ''}{cmp.recall10Delta.toFixed(2)}</span>
              {cmp.interval && <span className="faint num">（95% 区间 {cmp.interval[0].toFixed(2)} ~ {cmp.interval[1].toFixed(2)}）</span>}
            </strong>
            <p>
              成对比较：胜 <span className="num">{cmp.wins}</span> / 负 <span className="num">{cmp.losses}</span> / 平 <span className="num">{cmp.ties}</span>。{VERDICT[cmp.verdict].text}
            </p>
          </div>
        </div>
      )}
      <MetricCards run={run} />
      {byCase.length > 0 && (
        <section className="kb-section">
          <div className="kb-section-head">
            <h2 className="kb-h2">逐用例诊断</h2>
            <span className="faint">按 {label(focus ?? '')} 归类</span>
            <span className="kb-spacer" />
            <Segmented
              size="sm"
              ariaLabel="按诊断筛选"
              value={diag}
              onChange={setDiag}
              options={[{ value: 'all' as const, label: '全部', count: byCase.length }, ...(['no_doc', 'not_retrieved', 'low_rank', 'ok'] as const).map((d) => ({ value: d, label: DIAGNOSIS[d].label, icon: DIAGNOSIS[d].icon, count: n(d) }))]}
            />
          </div>
          <ul className="kb-diag-list">
            {rows.map(([caseId, ps]) => {
              const mine = ps.find((p) => p.variant === focus) ?? ps[0]!
              const d = DIAGNOSIS[mine.diagnosis]
              const Icon = d.icon
              const v = variantFor(mine.diagnosis, run.variants.find((x) => x.id === focus))
              return (
                <li key={caseId} className="kb-diag" data-tone={d.tone}>
                  <span className="kb-diag-mark" title={d.label}>
                    <Icon aria-hidden />
                    {d.label}
                  </span>
                  <div className="kb-diag-main">
                    <span className="kb-case-q">{cases[caseId]?.query ?? caseId}</span>
                    <span className="kb-diag-variants">
                      {ps.map((p) => (
                        <span key={p.variant} className="faint">
                          {label(p.variant)}：{p.firstRelevantRank ? `第 ${p.firstRelevantRank} 名` : '未找到'}
                          {p.missed.length ? <span className="mono"> · 漏 {p.missed.join('、')}</span> : null}
                        </span>
                      ))}
                    </span>
                    {d.advice && <span className="kb-diag-advice">{d.advice}</span>}
                  </div>
                  {v ? (
                    <button type="button" className="btn btn-sm" onClick={() => onVariant(v)}>
                      <Wand2 />
                      生成参数变体
                    </button>
                  ) : mine.diagnosis === 'no_doc' ? (
                    <button type="button" className="btn btn-sm" onClick={() => setQuery({ tab: 'sources', run: undefined })}>
                      <FilePlus2 />
                      补文档
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
