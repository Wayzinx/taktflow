import { useState, type CSSProperties } from 'react'
import { Archive, ArrowUpRight, Crosshair, FlaskConical, ShieldCheck } from 'lucide-react'
import type { EvalCase } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, ReasonDialog, Segmented, SkeletonRows, toast, useStagger } from '../../components/ui'
import { fmtDate, fmtRelative } from '../../lib/format'
import { Link, setQuery } from '../../lib/router'
import { SAMPLE_KIND, shortId, targetKey } from './labels'

type Filter = 'active' | 'must_catch' | 'clean' | 'retired'

const checkpointParts = (id: string) => {
  const [runId = '', nodeId = '', , , subject = ''] = id.split(':')
  return { runId, nodeId, subject }
}

/**
 * 样本（docs/design/21 §6）：必须拦住（来自人确认的漏检）与无缺陷（人确认无问题的评审调用），
 * 都绑定检查点当时的快照。退役需要原因，退役后不再参与新的评测；已有报告用的是开始时冻结的副本，不受影响。
 */
export function Samples() {
  const ds = useSource()
  const q = useAsync((d) => d.evalCases(undefined, { retired: true }), [])
  const [filter, setFilter] = useState<Filter>('active')
  const [retire, setRetire] = useState<EvalCase>()
  const all = (q.data ?? []).filter((c) => c.sample)
  const active = all.filter((c) => !c.sample!.retiredAt)
  const list = all
    .filter((c) => (filter === 'retired' ? c.sample!.retiredAt : !c.sample!.retiredAt && (filter === 'active' || c.sample!.kind === filter)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const stg = useStagger(list.length)
  const count = (k: 'must_catch' | 'clean') => active.filter((c) => c.sample!.kind === k).length
  const legacy = (q.data ?? []).length - all.length
  return (
    <>
      <div className="ev-toolbar">
        <Segmented<Filter>
          size="sm"
          ariaLabel="样本筛选"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: '在用', count: active.length },
            { value: 'must_catch', label: SAMPLE_KIND.must_catch.label, count: count('must_catch') },
            { value: 'clean', label: SAMPLE_KIND.clean.label, count: count('clean') },
            { value: 'retired', label: '已退役', count: all.length - active.length },
          ]}
        />
        <span className="faint ev-toolbar-hint">
          必须拦住：在缺陷的逐检查点结论里生成；无缺陷：在运行页节点抽屉的检查点里生成。
          {legacy > 0 && ` 另有 ${legacy} 条旧整节点用例，本期不再回放。`}
        </span>
      </div>
      <div className="card">
        {q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={q.reload} />
        ) : !q.data ? (
          <SkeletonRows rows={4} />
        ) : list.length === 0 ? (
          <EmptyState
            compact
            icon={FlaskConical}
            title={filter === 'retired' ? '没有退役的样本' : '还没有样本'}
            body={filter === 'retired' ? '退役的样本会留在这里，带退役时间。' : '确认一个"本该拦住"的漏检后，在缺陷详情里生成必拦样本；评审调用确认没问题时，在检查点里生成无缺陷样本。'}
          />
        ) : (
          <ul className="sm-list">
            {list.map((c, i) => {
              const s = c.sample!
              const k = SAMPLE_KIND[s.kind]
              const cp = checkpointParts(s.checkpointId)
              return (
                <li key={c.id} className={`sm-row${s.retiredAt ? ' is-retired' : ''} ${stg(i).className ?? ''}`} style={{ ...stg(i).style, '--i': i } as CSSProperties}>
                  <span className={`sm-ic sm-${s.kind}`} aria-hidden>
                    {s.kind === 'must_catch' ? <Crosshair /> : <ShieldCheck />}
                  </span>
                  <div className="sm-main">
                    <div className="sm-top">
                      <span className={`er-tag er-tone-${k.tone}`} title={k.hint}>
                        {k.label}
                      </span>
                      <span className="mono faint" title={c.id}>
                        {shortId(c.id)}
                      </span>
                      <span className="sm-title truncate">{c.title}</span>
                    </div>
                    {s.expectIssue && (
                      <p className="sm-expect">
                        期望提出：<b>{s.expectIssue}</b>
                      </p>
                    )}
                    <div className="sm-meta faint">
                      <Link to={`/run/${cp.runId}?node=${encodeURIComponent(cp.nodeId)}&dtab=checkpoints`} className="sm-cp mono" title={s.checkpointId}>
                        {cp.nodeId} · {cp.subject}
                        <ArrowUpRight />
                      </Link>
                      <span className="mono">{cp.runId}</span>
                      {c.source.defectId && <span className="mono">{c.source.defectId}</span>}
                      <span className="mono truncate sm-snap" title={s.snapshot}>
                        {s.snapshot}
                      </span>
                    </div>
                  </div>
                  <div className="sm-side">
                    {s.retiredAt ? (
                      <span className="sm-retired" title={fmtDate(s.retiredAt)}>
                        <Archive />
                        {fmtRelative(s.retiredAt)}退役
                      </span>
                    ) : (
                      <>
                        <span className="faint">{fmtRelative(c.createdAt)}</span>
                        <button type="button" className="btn btn-xs btn-ghost" onClick={() => setQuery({ tab: 'runs', new: targetKey(c.target) })} title="以这个样本的目标新建评测">
                          评测
                        </button>
                        <button type="button" className="btn btn-xs btn-ghost" onClick={() => setRetire(c)}>
                          <Archive />
                          退役
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <ReasonDialog
        open={Boolean(retire)}
        onClose={() => setRetire(undefined)}
        title={retire ? `退役样本 ${shortId(retire.id)}？` : ''}
        description="退役后不再参与新的评测；已有报告用的是开始时冻结的副本，不受影响。退役不能撤销，要再用需要从检查点重新生成。"
        confirmLabel="退役"
        onSubmit={async (reason) => {
          if (!retire) return
          await ds.retireEvalSample(retire.id, reason)
          invalidate()
          toast(`已退役 ${shortId(retire.id)}`, { tone: 'success' })
        }}
      />
    </>
  )
}
