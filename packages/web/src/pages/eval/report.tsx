import { Fragment, useState, type CSSProperties } from 'react'
import { AlertTriangle, ArrowRight, Ban, ChevronRight, CircleHelp, Compass, FlaskConical, Lock, Package, Scale, ShieldCheck } from 'lucide-react'
import type { EvalCase, EvalReport, EvalRun } from '@taktflow/core'
import { setQuery } from '../../lib/router'
import { GATE_VERDICT, ISOLATION_MODE, pct, REPLAY_OUTCOME, SAMPLE_KIND, shortId, targetKey, variantPair } from './labels'
import './eval-report.css'

/**
 * 检查点回放报告（docs/design/21 §5–6）：
 * - 顶部：门槛结论（达标 / 不达标 / 不适用）或"探索性"，旁附门槛快照；
 * - 每个变体：通过率点估计 + Wilson 95% 区间、误报、证据不足；
 * - 每个样本：逐次结论（通过 / 失败 / 证据不足，误报单独标）；
 * - 隔离方式、候选包与评委；拒绝启动时说清哪条不满足、下一步怎么做。
 */

type Run = EvalReport['samples'][number]['variants'][string]['runs'][number]

/** 列表与详情头部共用：探索性 / 门槛结论。 */
export function ReportBadge({ run }: { run: EvalRun }) {
  const r = run.report
  if (!r || run.status === 'refused' || run.status === 'running') return null
  if (r.exploratory)
    return (
      <span className="er-tag er-tone-waiting" title="样本数、重复次数或隔离方式不满足门槛：只作探索，不作发布依据">
        <Compass aria-hidden />
        探索性
      </span>
    )
  if (!r.gate) return null
  const g = GATE_VERDICT[r.gate.verdict]
  return (
    <span className={`er-tag er-tone-${g.tone}`} title={g.hint}>
      <Scale aria-hidden />
      门槛{g.label}
    </span>
  )
}

function GateSnapshot({ gate }: { gate: NonNullable<EvalReport['gate']>['config'] }) {
  const rows: Array<[string, string]> = [
    ['最少样本', `${gate.minSamples} 个`],
    ['最少重复', `${gate.minRepeats} 次`],
    ['通过率最多下降', `${Math.round(gate.maxPassRateDrop * 100)} 个百分点`],
    ['误报最多增加', `${gate.maxFalsePositiveIncrease} 次`],
    ['回归样本', gate.regressionsMustPass ? '必须全过' : '不要求全过'],
  ]
  return (
    <div className="er-gate-snap">
      <div className="er-k">门槛快照 <span className="faint">· 开始时冻结，之后改门槛不影响这份报告</span></div>
      <dl>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd className="num">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

export function ReportHead({ run }: { run: EvalRun }) {
  const r = run.report!
  const { baseline: b, candidate: k } = variantPair(run)
  const g = r.gate && GATE_VERDICT[r.gate.verdict]
  // 空间没配门槛时后端不给 gate，原因由这里补：不然"探索性"没有出处
  const reasons = r.gate
    ? r.gate.reasons
    : ['空间还没设发布门槛（最少样本、最少重复、允许的通过率下降），报告只作探索', ...(run.isolation?.mode === 'simulated' ? ['mock 模拟隔离，只用于测试和演示'] : [])]
  const tone = r.exploratory ? 'waiting' : (g?.tone ?? 'skipped')
  return (
    <div className={`card er-head er-tone-line-${tone}`}>
      <div className="er-verdict">
        <div className="er-k">{r.exploratory ? '只作探索' : '发布门槛'}</div>
        <div className={`er-big er-c-${tone}`}>
          {r.exploratory ? <Compass aria-hidden /> : <Scale aria-hidden />}
          {r.exploratory ? '探索性' : (g?.label ?? '没有门槛')}
        </div>
        <p className="er-sub">
          {r.exploratory ? '样本或重复次数不够、或是模拟隔离：结果只作参考，不作发布依据。' : g ? g.hint : '空间还没设发布门槛，这份报告只作参考。'}
        </p>
        {reasons.length > 0 && (
          <ul className="er-reasons">
            {reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        {k && b && (
          <p className="er-pair faint">
            <b>{k.label}</b> 对比 {b.label} · 每个样本重复 <b className="num">{run.repeats ?? 1}</b> 次
          </p>
        )}
      </div>
      {r.gate && <GateSnapshot gate={r.gate.config} />}
    </div>
  )
}

/** 区间条：0–100% 轨道，区间为带，点估计为点。 */
function Interval({ rate, low, high, n, tone }: { rate: number; low: number; high: number; n: number; tone: string }) {
  return (
    <div className={`er-ci er-c-${tone}`} role="img" aria-label={n ? `通过率 ${pct(rate)}，95% 区间 ${pct(low)}–${pct(high)}，n=${n}` : '没有可计入的结果'}>
      <i className="er-ci-mid" aria-hidden />
      {n > 0 && (
        <>
          <i className="er-ci-band" style={{ '--lo': low, '--hi': high } as CSSProperties} />
          <i className="er-ci-dot" style={{ '--x': rate } as CSSProperties} />
        </>
      )}
    </div>
  )
}

export function PassRates({ run }: { run: EvalRun }) {
  const r = run.report!
  const { baseline: b } = variantPair(run)
  return (
    <div className="card er-rates">
      <div className="card-head">
        <span className="card-title">通过率与 95% 区间</span>
        <span className="faint er-hint">Wilson 区间；分母只算通过 + 失败，证据不足单列、不算通过</span>
      </div>
      <div className="er-rate-grid">
        <span className="er-th">版本</span>
        <span className="er-th er-axis" aria-hidden>
          <span>0</span>
          <span>50%</span>
          <span>100%</span>
        </span>
        <span className="er-th r">通过率</span>
        <span className="er-th r">误报</span>
        <span className="er-th r">证据不足</span>
        {run.variants.map((v, i) => {
          const p = r.passRate[v.id] ?? { rate: 0, low: 0, high: 1, n: 0 }
          const base = v.id === b?.id
          const fp = r.falsePositives[v.id] ?? 0
          const ins = r.insufficient[v.id] ?? 0
          return (
            <Fragment key={v.id}>
              <span className="er-vname" style={{ '--i': i } as CSSProperties}>
                <span className={`er-vtag ${base ? 'is-base' : 'is-cand'}`}>{base ? '基线' : '候选'}</span>
                <span className="truncate" title={v.label}>{v.label}</span>
              </span>
              <Interval {...p} tone={base ? 'base' : 'cand'} />
              <span className="r er-rate">
                <b className="num">{p.n ? pct(p.rate) : '—'}</b>
                <span className="faint num">{p.n ? `${pct(p.low)}–${pct(p.high)} · n=${p.n}` : 'n=0'}</span>
              </span>
              <span className={`r num ${fp ? 'er-c-failed' : 'faint'}`}>{fp}</span>
              <span className={`r num ${ins ? 'er-c-pending' : 'faint'}`}>{ins}</span>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

function Dot({ x, n }: { x: Run; n: number }) {
  const m = REPLAY_OUTCOME[x.outcome]
  return (
    <i className={`er-dot er-d-${x.outcome}${x.falsePositive ? ' is-fp' : ''}`} title={`第 ${n} 次：${m.label}${x.falsePositive ? '（误报）' : ''}${x.reason ? ` · ${x.reason}` : ''}`} aria-label={`第 ${n} 次${m.label}${x.falsePositive ? '，误报' : ''}`} />
  )
}

export function SampleMatrix({ run, cases }: { run: EvalRun; cases: EvalCase[] }) {
  const r = run.report!
  const [open, setOpen] = useState<string>()
  const pool = run.frozenCases ?? cases
  const title = (id: string) => pool.find((c) => c.id === id)?.title
  const { baseline: b } = variantPair(run)
  return (
    <div className="card er-matrix">
      <div className="card-head">
        <span className="card-title">逐个样本</span>
        <span className="faint num">{r.samples.length}</span>
        <span className="spacer" />
        <span className="er-legend faint">
          {(['pass', 'fail', 'insufficient'] as const).map((o) => (
            <span key={o}>
              <i className={`er-dot er-d-${o}`} aria-hidden />
              {REPLAY_OUTCOME[o].label}
            </span>
          ))}
          <span>
            <i className="er-dot er-d-fail is-fp" aria-hidden />
            误报
          </span>
        </span>
      </div>
      <div className="er-m-grid" style={{ '--cols': run.variants.length } as CSSProperties}>
        <span className="er-th">样本</span>
        {run.variants.map((v) => (
          <span key={v.id} className="er-th">
            {v.id === b?.id ? '基线' : '候选'}
          </span>
        ))}
        {r.samples.map((s, i) => {
          const kind = s.kind === 'node' ? undefined : SAMPLE_KIND[s.kind]
          const on = open === s.caseId
          const why = run.variants.flatMap((v) => s.variants[v.id]!.runs.map((x, n) => ({ v, x, n })).filter(({ x }) => x.reason))
          return (
            <Fragment key={s.caseId}>
              <button type="button" className={`er-m-row${on ? ' open' : ''}`} style={{ '--i': i } as CSSProperties} onClick={() => setOpen(on ? undefined : s.caseId)} aria-expanded={on} disabled={!why.length}>
                <span className="er-m-name">
                  <ChevronRight className="er-caret" aria-hidden />
                  {kind ? <span className={`er-tag er-tone-${kind.tone}`} title={kind.hint}>{kind.label}</span> : <span className="er-tag">整节点</span>}
                  <span className="mono faint" title={s.caseId}>
                    {shortId(s.caseId)}
                  </span>
                  <span className="truncate">{title(s.caseId)}</span>
                </span>
                {run.variants.map((v) => {
                  const c = s.variants[v.id]!
                  return (
                    <span key={v.id} className="er-m-cell">
                      <span className="er-dots">
                        {c.runs.map((x, n) => (
                          <Dot key={n} x={x} n={n + 1} />
                        ))}
                      </span>
                      <span className="num faint">
                        {c.pass}/{c.runs.length}
                      </span>
                    </span>
                  )
                })}
              </button>
              {on && (
                <ul className="er-m-why">
                  {why.map(({ v, x, n }) => (
                    <li key={`${v.id}-${n}`}>
                      <span className={`er-tag er-tone-${REPLAY_OUTCOME[x.outcome].tone}`}>{x.falsePositive ? '误报' : REPLAY_OUTCOME[x.outcome].label}</span>
                      <span className="faint">
                        {v.id === b?.id ? '基线' : '候选'} 第 {n + 1} 次
                      </span>
                      <span>{x.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

export function IsolationCard({ run }: { run: EvalRun }) {
  const iso = run.isolation
  const mode = iso?.mode ? ISOLATION_MODE[iso.mode] : undefined
  const judge = run.report?.judge
  return (
    <div className="card er-iso">
      <div className="er-iso-cell">
        <div className="er-k">隔离</div>
        {mode ? (
          <div className={`er-iso-mode er-c-${mode.tone}`}>
            {iso?.mode === 'simulated' ? <FlaskConical aria-hidden /> : iso?.mode === 'sandbox' ? <Lock aria-hidden /> : <ShieldCheck aria-hidden />}
            {mode.label}
          </div>
        ) : (
          <div className="faint">未知</div>
        )}
        {mode && <p className="er-sub">{mode.hint}</p>}
      </div>
      <div className="er-iso-cell">
        <div className="er-k">候选包 <span className="faint">· 按内容哈希寻址，不写回正式空间</span></div>
        {run.candidates && Object.keys(run.candidates).length ? (
          <ul className="er-cands">
            {run.variants.map((v) => (
              <li key={v.id}>
                <Package aria-hidden />
                <span className="truncate" title={v.label}>{v.label}</span>
                <span className="mono" title={run.candidates?.[v.id]}>
                  {run.candidates?.[v.id] ? shortId(run.candidates[v.id]!) : '—'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="faint er-sub">还没有冻结候选包。</p>
        )}
      </div>
      <div className="er-iso-cell">
        <div className="er-k">评委</div>
        <p className="er-sub">
          {judge?.blind ? '盲评：对评委隐藏组别，展示顺序按哈希打乱' : '没有记录评委信息'}
        </p>
        {run.judgeCandidate && (
          <span className="mono er-sub" title={run.judgeCandidate}>
            评委候选包 {shortId(run.judgeCandidate)}
          </span>
        )}
        {run.frozenCases && <p className="faint er-sub">开始时冻结了 {run.frozenCases.length} 个样本；之后退役或改动不影响这份报告。</p>}
      </div>
    </div>
  )
}

/** 拒绝原因 → 下一步。原因是后端原文，按关键词给出处理建议；对不上的给通用说明。 */
function nextStep(reason: string): string {
  if (/readOnly|bwrap|docker|沙箱|隔离/.test(reason)) return '在服务器上装 bwrap 或 docker；或把候选换成声明了 readOnly 能力的 harness（设置 → 运行环境里能看到各 harness 的能力）。'
  if (/旧整节点用例|整节点回放/.test(reason)) return '本期只回放只读检查点：取消勾选旧用例，从缺陷的逐检查点结论生成必拦样本，或从评审检查点生成无缺陷样本。'
  if (/归因|改判/.test(reason)) return '回到对应缺陷，确认这个检查点的漏检结论；或者在样本列表里退役它，再重新发起。'
  if (/退役/.test(reason)) return '取消勾选已退役的样本后重新发起。'
  if (/快照|重新采集|重新创建/.test(reason)) return '在样本列表里退役这个样本，从检查点重新生成。'
  return '按原因处理后重新发起。'
}

export function RefusedCard({ run }: { run: EvalRun }) {
  const reasons = run.isolation?.reasons?.length ? run.isolation.reasons : (run.report?.gate?.reasons ?? [])
  return (
    <div className="card er-refused" role="alert">
      <div className="er-refused-head">
        <Ban aria-hidden />
        <b>拒绝启动：启动前的隔离与样本校验没通过</b>
        <span className="faint">没有回放、没有消耗 token</span>
      </div>
      {reasons.length ? (
        <ol className="er-refused-list">
          {reasons.map((x, i) => (
            <li key={x} style={{ '--i': i } as CSSProperties}>
              <span className="er-refused-n num">{i + 1}</span>
              <div>
                <p className="er-refused-why">
                  <AlertTriangle aria-hidden />
                  {x}
                </p>
                <p className="er-refused-next">
                  <ArrowRight aria-hidden />
                  {nextStep(x)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="faint">
          <CircleHelp aria-hidden /> 服务端没有给出原因。
        </p>
      )}
      <div className="er-refused-act">
        <button type="button" className="btn btn-sm" onClick={() => setQuery({ tab: 'cases', run: undefined })}>
          去样本列表
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setQuery({ new: targetKey(run.target) })}>
          处理后重新发起
        </button>
      </div>
    </div>
  )
}
