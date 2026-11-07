import { useEffect, useMemo, useState } from 'react'
import type { KnowledgeBaseDetail, KnowledgeEvalCase, KnowledgeEvalRun, KnowledgeEvalVariant } from '@taktflow/core'
import { Download, FlaskConical, Play, Sparkles } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, Segmented, SkeletonRows, toast } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { setQuery, useLocation } from '../../lib/router'
import { CaseList } from './eval-cases'
import { EvalRunDialog } from './eval-run-dialog'
import { RunResult } from './eval-run'
import { SOURCE_META } from './meta'

const VERDICT_TAG = { better: ['更好', 'success'], worse: ['更差', 'failed'], same: ['持平', undefined], inconclusive: ['不确定', 'waiting'] } as const

/** 运行中的评测：每 0.8 秒轮询一次，结束后通知列表刷新。 */
function usePolledRun(baseId: string, run: KnowledgeEvalRun | undefined, onDone: () => void): KnowledgeEvalRun | undefined {
  const ds = useSource()
  const [live, setLive] = useState<KnowledgeEvalRun>()
  useEffect(() => {
    setLive(undefined)
    if (!run || run.status !== 'running') return
    const t = setInterval(async () => {
      const r = await ds.knowledgeEvalRun(baseId, run.id).catch(() => undefined)
      if (!r) return
      setLive(r)
      if (r.status !== 'running') (clearInterval(t), onDone())
    }, 800)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, baseId, run?.id, run?.status])
  return live && live.id === run?.id ? live : run
}

export function EvalTab({ base }: { base: KnowledgeBaseDetail }) {
  const ds = useSource()
  const { query } = useLocation()
  const sets = useAsync((d) => d.knowledgeEvalSets(base.id), [base.id])
  const runs = useAsync((d) => d.knowledgeEvalRuns(base.id), [base.id])
  const [setId, setSetId] = useState<string>()
  const [dialog, setDialog] = useState<{ open: boolean; extra?: KnowledgeEvalVariant }>({ open: false })
  const [gen, setGen] = useState<'synth' | 'harvest'>()
  const set = sets.data?.find((s) => s.id === setId) ?? sets.data?.[0]
  const runId = query.get('run') ?? runs.data?.[0]?.id
  const selected = usePolledRun(base.id, runs.data?.find((r) => r.id === runId), runs.reload)
  const cases = useMemo(() => Object.fromEntries((sets.data ?? []).flatMap((s) => s.cases).map((c) => [c.id, c])) as Record<string, KnowledgeEvalCase>, [sets.data])

  async function generate(kind: 'synth' | 'harvest') {
    const target = set?.id ?? 'es-core'
    setGen(kind)
    try {
      const added = kind === 'synth' ? await ds.synthesizeKnowledgeCases(base.id, target, 6) : await ds.harvestKnowledgeCases(base.id, target)
      sets.reload()
      toast(`${kind === 'synth' ? '合成' : '采集'}了 ${added.length} 条候选用例`, { body: '确认后才参与发布门槛。' })
    } catch (e) {
      toast(kind === 'synth' ? '合成失败' : '采集失败', { tone: 'failed', body: (e as Error).message })
    } finally {
      setGen(undefined)
    }
  }

  if (sets.error && !sets.data) return <ErrorState error={sets.error} onRetry={sets.reload} />
  if (!sets.data || !runs.data) return <SkeletonRows rows={6} />
  const genButtons = (
    <>
      <button type="button" className="btn btn-sm" disabled={!!gen} onClick={() => void generate('synth')} title="模型从文档块出题，只做回归，不能单独作为发布依据">
        <Sparkles />
        <span className={gen === 'synth' ? 'shimmer-text' : undefined}>合成用例</span>
      </button>
      <button type="button" className="btn btn-sm" disabled={!!gen} onClick={() => void generate('harvest')} title="真实查询中被产物引用的命中，确认后入库">
        <Download />
        <span className={gen === 'harvest' ? 'shimmer-text' : undefined}>采集线上用例</span>
      </button>
    </>
  )
  if (!sets.data.length)
    return <EmptyState icon={FlaskConical} title="还没有评测集" body="在检索测试里标注几条，或者先合成一批用例，就能比较版本和参数。" action={<button type="button" className="btn btn-primary" onClick={() => setQuery({ tab: 'query' })}>去检索测试标注</button>} stewardAsk={`帮我给知识库「${base.name}」建一个评测集`} />

  return (
    <div className="kb-eval">
      <section className="kb-section">
        <div className="kb-section-head">
          <h2 className="kb-h2">评测集</h2>
          <Segmented size="sm" ariaLabel="评测集" value={set?.id ?? ''} onChange={setSetId} options={sets.data.map((s) => ({ value: s.id, label: s.title, count: s.cases.length }))} />
          <span className="kb-spacer" />
          {genButtons}
        </div>
        {set && (
          <>
            <div className="kb-source-row">
              {(Object.keys(SOURCE_META) as Array<keyof typeof SOURCE_META>).map((k) => {
                const n = set.cases.filter((c) => c.source === k).length
                return (
                  <span key={k} className={`kb-source${n ? '' : ' none'}`} title={SOURCE_META[k].hint}>
                    <span className="kb-tag" data-tone={SOURCE_META[k].tone}>
                      {SOURCE_META[k].label}
                    </span>
                    <span className="num">{n}</span>
                  </span>
                )
              })}
            </div>
            <CaseList key={set.id} baseId={base.id} set={set} onSaved={sets.reload} />
          </>
        )}
      </section>

      <section className="kb-section">
        <div className="kb-section-head">
          <h2 className="kb-h2">评测运行</h2>
          {runs.data.length > 0 && (
            <select className="select kb-run-pick" value={runId} onChange={(e) => setQuery({ run: e.target.value })} aria-label="选择评测运行">
              {runs.data.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} · {r.variants.map((v) => v.label).join(' / ')} · {fmtRelative(r.startedAt)}
                  {r.comparison ? ` · ${VERDICT_TAG[r.comparison.verdict][0]}` : ''}
                </option>
              ))}
            </select>
          )}
          <span className="kb-spacer" />
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ open: true })}>
            <Play />
            发起评测
          </button>
        </div>
        {selected ? (
          <RunResult key={selected.id} run={selected} cases={cases} onVariant={(v) => setDialog({ open: true, extra: v })} />
        ) : (
          <EmptyState compact icon={FlaskConical} title="还没有跑过评测" body="比较已发布和候选版本，发布门槛就有依据了。" action={<button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ open: true })}>发起评测</button>} />
        )}
      </section>

      <EvalRunDialog
        base={base}
        sets={sets.data}
        open={dialog.open}
        extra={dialog.extra}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
        onStarted={(r) => {
          runs.reload()
          setQuery({ run: r.id })
          toast(`评测 ${r.id} 已开始`, { tone: 'running', body: r.variants.map((v) => v.label).join(' 对比 ') })
        }}
      />
    </div>
  )
}
