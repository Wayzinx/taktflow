import { useState } from 'react'
import { ArrowUpRight, Check, ChevronRight, RotateCw, X } from 'lucide-react'
import type { AutomationConfig, AutomationRunRecord, ChannelView } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { Drawer, EmptyState, ErrorState, SkeletonRows, StatusDot, toast } from '../../components/ui'
import { fmtDate, fmtDuration, fmtRelative } from '../../lib/format'
import { Link } from '../../lib/router'
import { EVENTS, RUN_STATUS, TRIGGER_KIND } from './model'

function Record({ r, channels, onRetry }: { r: AutomationRunRecord; channels: ChannelView[]; onRetry?: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const st = RUN_STATUS[r.status]
  const name = (id: string) => channels.find((c) => c.id === id)?.title ?? id
  return (
    <li className="au-rec" data-status={r.status}>
      <div className="au-rec-head">
        <StatusDot tone={st.tone} pulse={r.status === 'running'} />
        <b>{st.label}</b>
        <span className="faint" title={r.at}>
          {fmtDate(r.at)} · {fmtRelative(r.at)}
        </span>
        <span className="au-rec-trigger">
          {TRIGGER_KIND[r.trigger]}
          {r.event && (
            <>
              ：{EVENTS[r.event.type].label}
              {r.event.requirementId && <span className="mono"> {r.event.requirementId}</span>}
            </>
          )}
        </span>
        <span className="spacer" />
        {r.durationMs !== undefined && <span className="faint num">{fmtDuration(r.durationMs)}</span>}
      </div>
      <p className="au-rec-summary">{r.summary}</p>
      {(r.deliveries.length > 0 || r.runId) && (
        <div className="au-rec-meta">
          {r.deliveries.map((d) => (
            <span key={d.channel} className={`au-dlv${d.ok ? ' ok' : ' bad'}`} title={d.error}>
              {d.ok ? <Check aria-hidden /> : <X aria-hidden />}
              {name(d.channel)}
              {!d.ok && d.status ? <span className="num"> {d.status}</span> : null}
            </span>
          ))}
          {r.runId && (
            <Link to={`/run/${encodeURIComponent(r.runId)}`} className="au-dlv link">
              运行 <span className="mono">{r.runId}</span>
              <ArrowUpRight aria-hidden />
            </Link>
          )}
        </div>
      )}
      {r.deliveries.filter((d) => !d.ok && d.error).map((d) => (
        <p key={d.channel} className="au-rec-error">
          {name(d.channel)}：{d.error}
        </p>
      ))}
      {!r.deliveries.length && r.error && <p className="au-rec-error">{r.error}</p>}
      <div className="au-rec-acts">
        {r.text && (
          <button type="button" className="btn btn-sm btn-ghost au-rec-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <ChevronRight aria-hidden />
            发出的内容
          </button>
        )}
        {r.retryOf && <span className="faint">重试自上一条失败记录</span>}
        <span className="spacer" />
        {onRetry && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void onRetry().finally(() => setBusy(false))
            }}
          >
            <RotateCw aria-hidden />
            {busy ? '重试中…' : '重试'}
          </button>
        )}
      </div>
      {open && r.text && <pre className="au-rec-text">{r.text}</pre>}
    </li>
  )
}

/** 执行记录：最近 20 次，新的在前；失败的能按原触发输入重试（docs/design/30 §4）。 */
export function RunLog({ automation, channels, open, onClose, onChanged }: { automation?: AutomationConfig; channels: ChannelView[]; open: boolean; onClose: () => void; onChanged: () => void }) {
  const ds = useSource()
  const id = automation?.id
  const q = useAsync((d) => (open && id ? d.automationRuns(id) : Promise.resolve(undefined)), [open, id])
  const retry = async (r: AutomationRunRecord) => {
    try {
      const rec = await ds.retryAutomationRun(r.automationId, r.id, `重试「${automation?.title ?? r.automationId}」${fmtDate(r.at)} 失败的执行`)
      toast(rec.status === 'ok' ? '重试成功' : rec.status === 'skipped' ? '重试跳过了' : '重试还是失败', { tone: rec.status === 'failed' ? 'failed' : undefined, body: rec.summary })
      q.reload()
      onChanged()
    } catch (e) {
      toast('没重试成', { tone: 'failed', body: (e as Error).message })
    }
  }
  return (
    <Drawer open={open} onClose={onClose} title={automation ? `「${automation.title}」的执行记录` : '执行记录'} description="最近 20 次，新的在前。" width={560}>
      <div className="au-log">
        {q.error ? (
          <ErrorState error={q.error} onRetry={q.reload} compact />
        ) : !q.data ? (
          <SkeletonRows rows={5} />
        ) : q.data.length === 0 ? (
          <EmptyState compact title="还没有执行过" body="到点或事件发生时会自动执行；也可以在列表里点“立即执行”试一次。" />
        ) : (
          <ul className="au-recs">
            {q.data.map((r) => (
              <Record key={r.id} r={r} channels={channels} onRetry={r.status === 'failed' ? () => retry(r) : undefined} />
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  )
}
