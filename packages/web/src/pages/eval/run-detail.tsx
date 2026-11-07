import { useEffect, type CSSProperties } from 'react'
import { ArrowLeft, CircleX, ShieldAlert } from 'lucide-react'
import type { EvalCase, EvalRun } from '@taktflow/core'
import { useAsync } from '../../api'
import { ErrorState, Meter, Skeleton, StatusBadge } from '../../components/ui'
import { TaktLoader } from '../../components/takt'
import { actorName, fmtDate } from '../../lib/format'
import { Link } from '../../lib/router'
import { pct, RUN_STATE, targetKey, targetLabel, variantPair, VERDICT_META } from './labels'
import { CaseCompare } from './case-compare'
import { VerdictBadge } from './runs-list'

function Overview({ run, cases }: { run: EvalRun; cases: EvalCase[] }) {
  const c = run.comparison
  const { baseline: b, candidate: k } = variantPair(run)
  if (!c || !b || !k) return null
  const total = Math.max(1, c.wins + c.losses + c.ties)
  const m = VERDICT_META[c.verdict]
  const delta = (c.passRate[k.id] ?? 0) - (c.passRate[b.id] ?? 0)
  const dScore = (c.meanScore[k.id] ?? 0) - (c.meanScore[b.id] ?? 0)
  return (
    <div className="card ev-overview">
      <div className="ev-ov-verdict">
        <div className="sc-metric-label">结论</div>
        <div className={`ev-ov-big ev-verdict-text-${c.verdict}`}>{m.label}</div>
        <div className="faint">
          {k.label} 对比 {b.label}
        </div>
      </div>
      <div className="ev-ov-cell">
        <div className="sc-metric-label">胜 / 负 / 平</div>
        <div className="ev-ov-num num">
          <span className="ev-w">{c.wins}</span> / <span className="ev-l">{c.losses}</span> / <span className="faint">{c.ties}</span>
        </div>
        <div className="ev-wlt" role="img" aria-label={`胜 ${c.wins}，负 ${c.losses}，平 ${c.ties}`}>
          <i className="ev-wlt-w" style={{ flexGrow: c.wins / total } as CSSProperties} />
          <i className="ev-wlt-t" style={{ flexGrow: c.ties / total } as CSSProperties} />
          <i className="ev-wlt-l" style={{ flexGrow: c.losses / total } as CSSProperties} />
        </div>
      </div>
      <div className="ev-ov-cell">
        <div className="sc-metric-label">通过率</div>
        {[b, k].map((v) => (
          <div key={v.id} className="ev-ov-rate">
            <span className="truncate">{v.id === b.id ? '基线' : '候选'}</span>
            <Meter value={c.passRate[v.id] ?? 0} tone={v.id === b.id ? 'skipped' : delta >= 0 ? 'success' : 'failed'} height={5} />
            <span className="num">{pct(c.passRate[v.id])}</span>
          </div>
        ))}
        <div className={`ev-delta num ${delta >= 0 ? 'ev-w' : 'ev-l'}`}>
          {delta >= 0 ? '+' : ''}
          {Math.round(delta * 100)} 个百分点
        </div>
      </div>
      <div className="ev-ov-cell">
        <div className="sc-metric-label">平均分</div>
        <div className="ev-ov-num num">
          {(c.meanScore[b.id] ?? 0).toFixed(1)} → {(c.meanScore[k.id] ?? 0).toFixed(1)}
        </div>
        <div className={`ev-delta num ${dScore >= 0 ? 'ev-w' : 'ev-l'}`}>
          {dScore >= 0 ? '+' : ''}
          {dScore.toFixed(1)}
        </div>
      </div>
      <div className="ev-ov-cell ev-ov-reg">
        <div className="sc-metric-label">回归用例</div>
        {c.regressionsFailed.length === 0 ? (
          <div className="ev-ov-num ev-w">全过</div>
        ) : (
          <>
            <div className="ev-ov-num ev-l">
              <ShieldAlert aria-hidden /> 挂了 {c.regressionsFailed.length} 条
            </div>
            {c.regressionsFailed.map((id) => (
              <div key={id} className="mono ev-reg-id truncate" title={cases.find((x) => x.id === id)?.title}>
                {id}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 评测失败（status failed）或结束了却没有对比结果：明确说出来，并列出各用例结果里的错误
 * （服务端同时把错误写进事件日志）。否则页面只剩一个"—"，分不清是失败还是没结论。
 */
function NoComparison({ run }: { run: EvalRun }) {
  const errors = run.results.filter((r) => r.error)
  const failed = run.status === 'failed'
  // 服务端把整体失败原因写成这个评测运行 id 下的 log 事件（level error）
  // ux-audit: ok 失败原因的补充日志，只在有内容时显示；没有时外层卡片已经说明了状态
  const log = useAsync(
    (ds) => (failed ? ds.events(run.id).then((es) => es.filter((e) => e.type === 'log' && (e.data as { level?: string }).level === 'error').map((e) => (e.data as { message: string }).message)).catch(() => [] as string[]) : Promise.resolve([] as string[])),
    [run.id, failed],
  )
  const st = RUN_STATE[run.status]
  return (
    <div className="card ev-failed" role={failed ? 'alert' : undefined}>
      <div className="ev-failed-head">
        <CircleX aria-hidden />
        <b>{failed ? '评测失败，没有产出对比结果' : '评测已结束，但没有对比结果'}</b>
        <StatusBadge meta={{ label: st.label, tone: st.tone, icon: CircleX }} subtle />
      </div>
      {log.data && log.data.length > 0 && (
        <ul className="ev-failed-list">
          {log.data.map((m, i) => (
            <li key={i} className="ev-failed-log">
              <span className="mono ev-failed-msg">{m}</span>
            </li>
          ))}
        </ul>
      )}
      {errors.length > 0 ? (
        <ul className="ev-failed-list">
          {errors.map((r) => (
            <li key={`${r.caseId}/${r.variant}`}>
              <span className="mono">{r.caseId}</span>
              <span className="faint mono">{r.variant}</span>
              <span className="mono ev-failed-msg">{r.error}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint">
          {failed ? log.data?.length ? '各用例结果里没有单独的错误信息。' : '用例结果里没有错误信息，也没读到失败日志。' : '需要基线与候选两个版本都有结果；如果把变体命名为 baseline，服务端不会再自动加当前配方的基线。'}
        </p>
      )}
    </div>
  )
}

export function RunDetail({ id }: { id: string }) {
  const q = useAsync((ds) => ds.evalRun(id), [id])
  const run = q.data
  const cases = useAsync((ds) => (run ? ds.evalCases(targetKey(run.target)) : Promise.resolve([])), [run ? targetKey(run.target) : ''])
  const running = run?.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(q.reload, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])
  if (q.error && !run) return <ErrorState error={q.error} onRetry={q.reload} />
  return (
    <div className="ev-run">
      <div className="ev-run-head">
        <Link to="/eval?tab=runs" className="btn btn-ghost btn-sm">
          <ArrowLeft />
          评测运行
        </Link>
        <h2 className="ev-run-title">
          <span className="mono">{id}</span>
          {run && (run.status === 'failed' ? <StatusBadge meta={{ label: RUN_STATE.failed.label, tone: 'failed', icon: CircleX }} /> : <VerdictBadge v={run.comparison} />)}
        </h2>
        {run ? (
          <span className="faint">
            <span className="mono">{targetLabel(run.target)}</span> · {run.caseIds.length} 条用例 · {actorName(run.by)} 于 {fmtDate(run.startedAt)}
          </span>
        ) : (
          <Skeleton w={260} h={12} />
        )}
      </div>
      {!run ? (
        <Skeleton h={120} />
      ) : running ? (
        <div className="card ev-running">
          <TaktLoader label={`正在沙箱里回放 ${run.caseIds.length} 条用例 × ${run.variants.length} 个版本，并由独立 evaluator 判分`} />
        </div>
      ) : (
        <>
          {run.comparison ? <Overview run={run} cases={cases.data ?? []} /> : <NoComparison run={run} />}
          <CaseCompare run={run} cases={cases.data ?? []} />
        </>
      )}
    </div>
  )
}
