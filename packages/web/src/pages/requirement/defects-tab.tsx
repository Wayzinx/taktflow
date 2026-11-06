import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Bug, FlaskConical, PencilLine, Plus, ScanSearch } from 'lucide-react'
import type { DefectDetail, RequirementDetail } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, SkeletonRows, toast } from '../../components/ui'
import { TaktLoader } from '../../components/takt'
import { actorName, fmtDate, fmtRelative } from '../../lib/format'
import { Link, setQuery, useLocation } from '../../lib/router'
import { DEFECT_STATUS, ORIGIN, pct, SEVERITY, targetKey } from '../eval/labels'
import { nodeIndex, Precheck, StageMarks, Suggestions, TraceChain } from './defects-tab.attribution'
import { ConfirmDialog } from './defects-tab.confirm'
import { DefectForm } from './defects-tab.form'
import '../eval/eval-runs.css'
import './defects-tab.css'

function Tag({ meta }: { meta: { label: string; tone: string } }) {
  return <span className={`df-tag df-tone-${meta.tone}`}>{meta.label}</span>
}

function RegressionCases({ d, runIds }: { d: DefectDetail; runIds: string[] }) {
  const q = useAsync((ds) => ds.evalCases(), [d.id, d.status])
  const list = (q.data ?? []).filter((c) => c.source.kind === 'defect' && c.source.defectId === d.id && (!c.source.runId || runIds.includes(c.source.runId)))
  if (!q.data) return <SkeletonRows rows={2} gap={10} />
  if (list.length === 0) return <p className="faint df-none">还没有生成回归用例。</p>
  return (
    <ul className="df-cases">
      {list.map((c) => (
        <li key={c.id}>
          <FlaskConical aria-hidden />
          <span className="truncate">{c.title}</span>
          <span className="mono faint">{targetKey(c.target)}</span>
          <Link to={`/eval?tab=runs&new=${encodeURIComponent(targetKey(c.target))}`} className="btn btn-ghost btn-sm">
            用它评测
            <ArrowUpRight />
          </Link>
        </li>
      ))}
    </ul>
  )
}

function Detail({ d, detail }: { d: DefectDetail; detail?: RequirementDetail }) {
  const ds = useSource()
  const a = d.attribution
  const runId = a?.introducedAt.runId ?? a?.missedBy[0]?.runId ?? detail?.latestRunId
  const run = useAsync((s) => (runId ? s.run(runId) : Promise.resolve(undefined)), [runId])
  const idx = useMemo(() => nodeIndex(run.data?.graph.nodes), [run.data])
  const [mode, setMode] = useState<'confirm' | 'edit'>()
  const [busy, setBusy] = useState(false)
  // 后台归因失败时服务端只把原因写进事件日志 defect-<需求>（DefectDetail 没有错误字段，见协议变更请求）：
  // 看到"归因中"结束了却没有结果，就明确说没成功，而不是悄悄回到"开始归因"
  const seenAttributing = useRef(false)
  const [ended, setEnded] = useState(false)
  useEffect(() => {
    if (d.attributing) seenAttributing.current = true
    else if (seenAttributing.current && !d.attribution) setEnded(true)
  }, [d.attributing, d.attribution])
  const attribute = async () => {
    setEnded(false)
    setBusy(true)
    try {
      await ds.attributeDefect(d.requirementId, d.id)
      invalidate()
    } catch (e) {
      toast('归因没能开始', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card df-detail fade-in">
      <div className="df-head">
        <div className="df-head-top">
          <span className="mono df-id">{d.id}</span>
          <Tag meta={SEVERITY[d.severity]} />
          <Tag meta={d.attributing ? { label: '归因中', tone: 'running' } : DEFECT_STATUS[d.status]} />
          <span style={{ flex: 1 }} />
          {d.links?.map((l) => (
            <a key={l.url} className="chip" href={l.url} target="_blank" rel="noreferrer">
              <ArrowUpRight />
              {l.title ?? l.type}
            </a>
          ))}
        </div>
        <h2 className="df-title">{d.title}</h2>
        <p className="df-desc">{d.description}</p>
        <div className="df-facts faint">
          <span>{actorName(d.reportedBy)} 录入于 {fmtDate(d.foundAt)}</span>
          {d.acs?.length ? <span>关联 {d.acs.map((x) => <span key={x} className="mono">{x} </span>)}</span> : null}
          {d.evidence?.map((e) => (
            <span key={e} className="mono">
              {e}
            </span>
          ))}
        </div>
      </div>

      {d.attributing ? (
        <div className="df-attributing">
          <TaktLoader label="auditor 正在读取缺陷、预检结果和溯源链上的各环节产物（只读、新会话）" />
        </div>
      ) : !a ? (
        <div className="df-start">
          {ended && (
            <p className="df-failed" role="alert">
              上一次归因已结束但没有产出候选，多半是 auditor 执行失败（原因记在服务端事件日志 <span className="mono">defect-{d.requirementId}</span>）。检查 auditor 角色的 harness 后可以重新归因。
            </p>
          )}
          <p>先做确定性预检（AC 有没有用例、代码由哪个节点改的、经过哪些评审与门禁，不花 token），再由独立的 auditor 角色沿溯源链给出归因候选。</p>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={attribute}>
            <ScanSearch />
            开始归因
          </button>
        </div>
      ) : (
        <div className="df-body">
          <section className="df-sec">
            <h3 className="df-h3">
              归因
              <span className="faint df-h3-sub">
                引入于{ORIGIN[a.introducedAt.origin].label} · 置信度 {pct(a.confidence)} · {actorName(a.by)} {fmtRelative(a.at)}
              </span>
            </h3>
            {detail?.stages.length ? <StageMarks a={a} stages={detail.stages} idx={idx} /> : null}
            <TraceChain a={a} idx={idx} runId={runId} />
          </section>
          <div className="df-cols">
            <section className="df-sec">
              <h3 className="df-h3">
                预检 <span className="faint df-h3-sub">确定性，不花 token</span>
              </h3>
              <Precheck p={a.precheck} />
            </section>
            <section className="df-sec">
              <h3 className="df-h3">改进建议</h3>
              <Suggestions list={a.suggestions} />
            </section>
          </div>
          {a.confirmed ? (
            <section className="df-sec df-confirmed">
              <h3 className="df-h3">
                已确认
                <span className="faint df-h3-sub">
                  {actorName(a.confirmed.by)} · {fmtDate(a.confirmed.at)}
                  {a.confirmed.edited && ' · 修改过归因'}
                </span>
              </h3>
              {a.confirmed.note && <p className="df-note">{a.confirmed.note}</p>}
              <h4 className="df-h4">生成的回归用例</h4>
              <RegressionCases d={d} runIds={detail?.runs.map((r) => r.runId) ?? (runId ? [runId] : [])} />
            </section>
          ) : (
            <div className="df-actions">
              <span className="faint">归因 Agent 的结论只是候选，确认后才计入成绩单和检出率。</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={() => setMode('edit')}>
                <PencilLine />
                修改归因
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => setMode('confirm')}>
                确认归因
              </button>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog mode={mode} defect={d} nodes={run.data?.graph.nodes ?? []} onClose={() => setMode(undefined)} />
    </div>
  )
}

/** 需求页"缺陷"Tab（docs/design/20 §3 / §6）：录入、列表、归因视图、确认 / 修改。 */
export function DefectsTab({ id, detail }: { id: string; detail?: RequirementDetail }) {
  const { query } = useLocation()
  const q = useAsync((ds) => ds.defects(id), [id])
  const [formOpen, setFormOpen] = useState(false)
  const list = q.data
  const attributing = list?.some((d) => d.attributing)
  useEffect(() => {
    if (!attributing) return
    const t = setInterval(q.reload, 900)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attributing])
  const selectedId = query.get('defect') ?? list?.[0]?.id
  const selected = list?.find((d) => d.id === selectedId)
  if (q.error && !list) return <ErrorState error={q.error} onRetry={q.reload} />
  const form = <DefectForm open={formOpen} requirementId={id} onClose={() => setFormOpen(false)} onCreated={(d) => (setFormOpen(false), setQuery({ defect: d.id }))} />
  if (list && list.length === 0)
    return (
      <div className="card">
        <EmptyState
          icon={Bug}
          title="还没有录入缺陷"
          hint="交付后发现的问题录到这里：预检 + 归因 Agent 找出在哪引入、哪里漏检，人确认后变成回归评测用例。"
          action={
            <button className="btn btn-sm btn-primary" onClick={() => setFormOpen(true)}>
              <Plus />
              录入缺陷
            </button>
          }
        />
        {form}
      </div>
    )
  return (
    <div className="df-layout">
      <div className="card df-list">
        <div className="card-head">
          <span className="card-title">缺陷</span>
          <span className="faint num">{list?.length ?? ''}</span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => setFormOpen(true)}>
            <Plus />
            录入
          </button>
        </div>
        {!list ? (
          <SkeletonRows rows={3} />
        ) : (
          <ul className="df-items" role="listbox" aria-label="缺陷列表">
            {list.map((d) => (
              <li key={d.id}>
                <button role="option" aria-selected={d.id === selectedId} className={`df-item${d.id === selectedId ? ' on' : ''}`} onClick={() => setQuery({ defect: d.id })}>
                  <span className="df-item-top">
                    <span className="mono">{d.id}</span>
                    <Tag meta={SEVERITY[d.severity]} />
                    <span style={{ flex: 1 }} />
                    <Tag meta={d.attributing ? { label: '归因中', tone: 'running' } : DEFECT_STATUS[d.status]} />
                  </span>
                  <span className="df-item-title">{d.title}</span>
                  <span className="faint df-item-at">{fmtRelative(d.foundAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected ? <Detail key={selected.id} d={selected} detail={detail} /> : <div className="card">{!list && <SkeletonRows rows={6} />}</div>}
      {form}
    </div>
  )
}
