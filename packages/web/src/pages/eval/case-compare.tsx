import { Fragment, useState } from 'react'
import { Check, ChevronDown, FileSearch, X } from 'lucide-react'
import type { EvalCase, EvalCaseResult, EvalRun } from '@taktflow/core'
import { useAsync } from '../../api'
import { Dialog, SkeletonRows } from '../../components/ui'
import { useLastDefined } from '../../lib/motion'
import { fmtCost, fmtDuration } from '../../lib/format'
import { CASE_SOURCE, caseOutcome as outcome, OUTCOME, variantPair } from './labels'

function Score({ r }: { r?: EvalCaseResult }) {
  if (!r) return <span className="faint">—</span>
  return (
    <span className={`ev-score ${r.pass ? 'ev-pass' : 'ev-fail'}`}>
      {r.pass ? <Check aria-label="通过" /> : <X aria-label="未过" />}
      <span className="num">{r.score ?? '—'}</span>
    </span>
  )
}

function Side({ title, r, onOpen }: { title: string; r?: EvalCaseResult; onOpen: () => void }) {
  if (!r) return <div className="ev-side faint">没有结果</div>
  return (
    <div className="ev-side">
      <div className="ev-side-head">
        <b>{title}</b>
        <Score r={r} />
        <span style={{ flex: 1 }} />
        <span className="faint num">
          {fmtDuration(r.durationMs)} · {fmtCost(r.usage.costUsd)}
        </span>
      </div>
      {r.error && <div className="sc-bad mono">{r.error}</div>}
      {r.rubric && (
        <p className="ev-reason">
          <span className="ev-reason-k">rubric {r.rubric.score}</span>
          {r.rubric.reason}
        </p>
      )}
      {r.reference && (
        <p className="ev-reason">
          <span className="ev-reason-k">对参考 {r.reference.score}</span>
          {r.reference.reason}
        </p>
      )}
      {r.checks && (
        <ul className="ev-checks">
          {r.checks.map((c) => (
            <li key={c.id} className={c.pass ? 'ev-pass' : 'ev-fail'}>
              {c.pass ? <Check aria-label="满足" /> : <X aria-label="未满足" />}
              <span>{c.criterion}</span>
              {c.evidence && <span className="faint mono truncate">{c.evidence}</span>}
            </li>
          ))}
        </ul>
      )}
      <button className="btn btn-sm" onClick={onOpen}>
        <FileSearch />
        输出快照
      </button>
    </div>
  )
}

function OutputDialog({ target, onClose }: { target?: { runId: string; caseId: string; variant: string; label: string }; onClose: () => void }) {
  const t = useLastDefined(target)
  const q = useAsync((ds) => (t ? ds.evalOutput(t.runId, t.caseId, t.variant) : Promise.resolve(undefined)), [t?.runId, t?.caseId, t?.variant])
  return (
    <Dialog open={Boolean(target)} onClose={onClose} size="lg" title={t ? `${t.caseId} · ${t.label}` : ''} description={q.data?.outputDir && <span className="mono">{q.data.outputDir}</span>}>
      {!q.data ? (
        <SkeletonRows rows={4} />
      ) : q.data.files.length === 0 ? (
        <p className="faint">没有输出快照（后端还没提供读取接口，见交付说明）。</p>
      ) : (
        <div className="ev-files">
          {q.data.files.map((f) => (
            <section key={f.path}>
              <div className="ev-file-path mono">{f.path}</div>
              <pre className="ev-file mono">{f.content}</pre>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  )
}

export function CaseCompare({ run, cases }: { run: EvalRun; cases: EvalCase[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const [snap, setSnap] = useState<{ runId: string; caseId: string; variant: string; label: string }>()
  const { baseline: b, candidate: k } = variantPair(run)
  if (!b || !k) return null
  const failed = new Set(run.comparison?.regressionsFailed ?? [])
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">逐用例对比</span>
        <span className="faint">点开看两边输出摘要与判分理由</span>
      </div>
      <table className="table ev-cases-table">
        <thead>
          <tr>
            <th>用例</th>
            <th>基线</th>
            <th>候选</th>
            <th>结果</th>
            <th aria-label="展开" />
          </tr>
        </thead>
        <tbody>
          {run.caseIds.map((id) => {
            const c = cases.find((x) => x.id === id)
            const rb = run.results.find((r) => r.caseId === id && r.variant === b.id)
            const rk = run.results.find((r) => r.caseId === id && r.variant === k.id)
            const o = outcome(rb, rk)
            const expanded = open === id
            return (
              <Fragment key={id}>
                <tr className={`clickable${expanded ? ' ev-row-open' : ''}`} onClick={() => setOpen(expanded ? null : id)} aria-expanded={expanded}>
                  <td className="ev-case-cell">
                    {c && <span className={`ev-src ev-src-${c.source.kind}`}>{CASE_SOURCE[c.source.kind]}</span>}
                    <span className="truncate">{c?.title ?? id}</span>
                    <span className="mono faint">{id}</span>
                    {failed.has(id) && <span className="sc-regress">回归未过</span>}
                  </td>
                  <td>
                    <Score r={rb} />
                  </td>
                  <td>
                    <Score r={rk} />
                  </td>
                  <td>{o && <span className={`ev-outcome ev-outcome-${o}`}>{OUTCOME[o]}</span>}</td>
                  <td>
                    <ChevronDown className={`ev-chev${expanded ? ' open' : ''}`} aria-hidden />
                  </td>
                </tr>
                {expanded && (
                  <tr className="ev-expand">
                    <td colSpan={5}>
                      <div className="ev-sides">
                        <Side title={`基线 · ${b.label}`} r={rb} onOpen={() => setSnap({ runId: run.id, caseId: id, variant: b.id, label: b.label })} />
                        <Side title={`候选 · ${k.label}`} r={rk} onOpen={() => setSnap({ runId: run.id, caseId: id, variant: k.id, label: k.label })} />
                      </div>
                      {(c?.grading.mustFind?.length || c?.grading.mustNotIntroduce?.length) && (
                        <div className="ev-must faint">
                          {c.grading.mustFind?.map((x) => <div key={x}>必须指出：{x}</div>)}
                          {c.grading.mustNotIntroduce?.map((x) => <div key={x}>不得引入：{x}</div>)}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      <OutputDialog target={snap} onClose={() => setSnap(undefined)} />
    </div>
  )
}
