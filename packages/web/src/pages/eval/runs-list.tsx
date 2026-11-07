import type { EvalRun } from '@taktflow/core'
import { ChevronRight, FlaskConical } from 'lucide-react'
import { EmptyState, SkeletonRows, StatusBadge, useFlashRows, useStagger } from '../../components/ui'
import { actorName, durationBetween, fmtDuration, fmtRelative } from '../../lib/format'
import { Link } from '../../lib/router'
import { Check, LoaderCircle, X } from 'lucide-react'
import { RUN_STATE, targetLabel, variantPair, VERDICT_META } from './labels'

/** 候选变体的名称：有 comparison 时就是它的 candidate，否则是基线之外的全部。 */
const candidates = (r: EvalRun): string[] => {
  const { baseline, candidate } = variantPair(r)
  return r.comparison ? (candidate ? [candidate.label] : []) : r.variants.filter((v) => v !== baseline).map((v) => v.label)
}

const STATE_ICON = { running: LoaderCircle, done: Check, failed: X }

export function VerdictBadge({ v }: { v?: EvalRun['comparison'] }) {
  if (!v) return <span className="faint">—</span>
  const m = VERDICT_META[v.verdict]
  return <span className={`ev-verdict ev-verdict-${v.verdict}`}>{m.label}</span>
}

export function RunsList({ runs, onNew }: { runs?: EvalRun[]; onNew: () => void }) {
  const stg = useStagger(runs?.length ?? 0)
  const flash = useFlashRows((runs ?? []).map((r) => r.id))
  if (!runs) return <SkeletonRows rows={3} />
  if (runs.length === 0)
    return (
      <EmptyState
        compact
        icon={FlaskConical}
        title="还没有评测运行"
        body="选一个节点或技能、勾选用例、填一个变体（技能 / prompt / 模型），在冻结输入上回放并与基线配对比较。"
        stewardAsk="帮我评测一下最近改过的技能是不是变好了"
        action={
          <button className="btn btn-sm btn-primary" onClick={onNew}>
            新建评测
          </button>
        }
      />
    )
  return (
    <div className="sc-wrap">
      <table className="table ev-runs">
        <thead>
          <tr>
            <th>运行</th>
            <th>目标</th>
            <th>候选变体</th>
            <th className="r">用例</th>
            <th>状态</th>
            <th>结论</th>
            <th className="r">胜 / 负 / 平</th>
            <th>回归用例</th>
            <th>开始</th>
            <th aria-label="打开" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => {
            const c = r.comparison
            const ms = durationBetween(r.startedAt, r.endedAt)
            const st = RUN_STATE[r.status]
            return (
              <tr key={r.id} className={`${stg(i).className ?? ''} ${flash(r.id)}`} style={stg(i).style}>
                <td>
                  <Link to={`/eval?tab=runs&run=${r.id}`} className="mono ev-run-id">
                    {r.id}
                  </Link>
                </td>
                <td className="mono truncate">{targetLabel(r.target)}</td>
                <td className="truncate ev-variant-cell" title={candidates(r).join('\n')}>
                  {candidates(r).join('、') || <span className="faint">—</span>}
                </td>
                <td className="r num">{r.caseIds.length}</td>
                <td>
                  <StatusBadge meta={{ label: st.label, tone: st.tone, icon: STATE_ICON[r.status], spin: r.status === 'running' }} subtle />
                </td>
                <td>
                  <VerdictBadge v={c} />
                </td>
                <td className="r num">{c ? `${c.wins} / ${c.losses} / ${c.ties}` : '—'}</td>
                <td>{c ? c.regressionsFailed.length > 0 ? <span className="sc-bad">挂了 {c.regressionsFailed.length} 条</span> : <span className="faint">全过</span> : <span className="faint">—</span>}</td>
                <td className="faint">
                  {fmtRelative(r.startedAt)} · {actorName(r.by)}
                  {ms !== undefined && <> · {fmtDuration(ms)}</>}
                </td>
                <td>
                  <Link to={`/eval?tab=runs&run=${r.id}`} className="btn btn-ghost btn-icon btn-sm" aria-label={`打开 ${r.id}`}>
                    <ChevronRight />
                  </Link>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
