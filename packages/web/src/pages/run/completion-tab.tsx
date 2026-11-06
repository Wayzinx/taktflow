import { Check, CircleDashed, Fingerprint, ListChecks, Repeat2, TriangleAlert, X } from 'lucide-react'
import type { CompletionCheck, EventPayloads, FailureRecord, NodeDetail } from '@taktflow/core'
import { EmptyState } from '../../components/ui'
import { fmtDate } from '../../lib/format'
import { Link } from '../../lib/router'
import './completion-tab.css'

type Verdict = 'pass' | 'no-evidence' | 'fail' | 'pending'

const VERDICT_META: Record<Verdict, { label: string; icon: typeof Check }> = {
  pass: { label: '通过', icon: Check },
  'no-evidence': { label: '缺证据', icon: TriangleAlert },
  fail: { label: '未满足', icon: X },
  pending: { label: '待自检', icon: CircleDashed },
}

function verdictOf(c?: CompletionCheck): Verdict {
  if (!c) return 'pending'
  if (!c.pass) return 'fail'
  return c.evidence?.trim() ? 'pass' : 'no-evidence'
}

/**
 * 节点抽屉"完成标准"Tab：逐条完成标准与最近一次自检（pass + 证据；pass 却没证据也算未满足，
 * 与引擎口径一致），失败指纹与被抑制的重试。
 */
export function CompletionTab({ d, runId, requirementId }: { d: NodeDetail; runId: string; requirementId: string }) {
  void runId
  const checks = d.completionChecks ?? []
  // 以完成标准为准逐条对齐；自检里多出来的（criterion 不在定义里）也列出，便于发现漂移
  const criteria = d.completion ?? checks.map((c) => c.criterion)
  const rows = criteria.map((criterion, i) => ({ id: `c${i + 1}`, criterion, check: checks.find((c) => c.id === `c${i + 1}`) ?? checks.find((c) => c.criterion === criterion) }))
  const extra = checks.filter((c) => !rows.some((r) => r.check === c))
  const all = [...rows, ...extra.map((c) => ({ id: c.id, criterion: c.criterion, check: c }))]
  const verdicts = all.map((r) => verdictOf(r.check))
  const passed = verdicts.filter((v) => v === 'pass').length
  const unmet = verdicts.filter((v) => v === 'fail' || v === 'no-evidence').length
  const checked = checks.length > 0
  const suppressed = d.events.filter((e) => e.type === 'retry.suppressed') as Array<{ seq: number; ts: string; data: EventPayloads['retry.suppressed'] }>
  const failures = d.failures ?? []

  if (all.length === 0 && failures.length === 0 && suppressed.length === 0) {
    return <EmptyState compact icon={ListChecks} title="这个节点没有完成标准" hint="在 workflow 里给节点加 completion，引擎会要求结果逐条自检并附证据。" />
  }

  return (
    <div className="dpad">
      {all.length > 0 && (
        <div className="d-section first">
          <div className="d-section-title">
            完成标准
            <span className={`cpl-sum ${!checked ? 'pending' : unmet ? 'fail' : 'pass'}`}>
              {!checked ? '尚未自检' : unmet ? `${unmet} 条未满足` : `${passed}/${all.length} 通过`}
            </span>
            <span className="d-section-hint faint">pass 必须带证据，否则按未满足处理</span>
          </div>
          <ol className="cpl-list">
            {all.map((r, i) => {
              const v = verdicts[i]!
              const M = VERDICT_META[v]
              return (
                <li key={r.id} className={`cpl-row v-${v}`}>
                  <span className="cpl-mark" title={M.label}>
                    <M.icon strokeWidth={2.6} aria-hidden />
                  </span>
                  <span className="mono cpl-id">{r.id}</span>
                  <div className="cpl-body">
                    <div className="cpl-criterion">{r.criterion}</div>
                    {r.check?.evidence ? <div className="mono cpl-evidence">{r.check.evidence}</div> : <div className="cpl-evidence faint">{v === 'pending' ? '节点完成后由 agent 逐条自检' : '没有给出证据'}</div>}
                  </div>
                  <span className="sr-only">{M.label}</span>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {(failures.length > 0 || suppressed.length > 0) && (
        <div className="d-section">
          <div className="d-section-title">
            <Fingerprint aria-hidden className="cpl-title-icon" />
            失败指纹
            <span className="d-section-hint faint">同一指纹在输入不变时第 2 次出现即停止重试</span>
          </div>
          <div className="fp-list">
            {failures.map((f) => (
              <FailureCard key={f.fingerprint} f={f} stop={suppressed.find((s) => s.data.fingerprint === f.fingerprint)?.data} />
            ))}
            {suppressed
              .filter((s) => !failures.some((f) => f.fingerprint === s.data.fingerprint))
              .map((s) => (
                <div key={s.seq} className="fp-card stopped">
                  <div className="fp-head">
                    <span className="mono fp-code">{s.data.code}</span>
                    <span className="fp-stop">
                      <Repeat2 aria-hidden />
                      已停止重试 · 第 {s.data.count} 次
                    </span>
                  </div>
                  <div className="fp-msg">{s.data.reason}</div>
                  <div className="mono faint fp-meta">指纹 {s.data.fingerprint} · {fmtDate(s.ts)}</div>
                </div>
              ))}
          </div>
          {suppressed.length > 0 && (
            <p className="faint d-note">
              只有新提交 / 新部署、输入产物出了新版本、或判决为 flaky 时才会再试。要人工决定就去{' '}
              <Link to="/attention">待办</Link>，或在 <Link to={`/req/${requirementId}?tab=chat`}>需求群</Link> 里告诉 Lead。
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function FailureCard({ f, stop }: { f: FailureRecord; stop?: EventPayloads['retry.suppressed'] }) {
  // 待办里选"再试一次"后引擎把该指纹的 count 清零（runtime.ts consume），记录还在：显示停止时的次数并说明已放行
  const released = Boolean(stop) && f.count === 0
  return (
    <div className={`fp-card${stop ? ' stopped' : ''}`}>
      <div className="fp-head">
        <span className="mono fp-code">{f.code}</span>
        {f.target && <span className="mono faint">→ {f.target}</span>}
        <span className="fp-count mono num" title={released ? `人工选择再试一次后计数清零；停止时为第 ${stop?.count} 次` : '同一指纹出现次数'}>
          ×{released ? stop?.count : f.count}
        </span>
        {stop && (
          <span className="fp-stop" title={stop.reason}>
            <Repeat2 aria-hidden />
            {released ? '停过 · 已人工放行' : '已停止重试'}
          </span>
        )}
      </div>
      {f.message && <div className="fp-msg">{f.message}</div>}
      <dl className="fp-meta">
        <dt>指纹</dt>
        <dd className="mono">{f.fingerprint}</dd>
        <dt>输入身份</dt>
        <dd className="mono">{f.inputs}</dd>
        <dt>首次 / 最近</dt>
        <dd className="mono">
          {fmtDate(f.firstAt)} → {fmtDate(f.lastAt)}
        </dd>
      </dl>
    </div>
  )
}
