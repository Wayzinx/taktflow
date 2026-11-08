import { useEffect, useState, type CSSProperties } from 'react'
import { ArrowUpRight, Check, ChevronRight, FlaskConical, HelpCircle, LoaderCircle, PencilLine, UserRoundCheck, X } from 'lucide-react'
import type { DefectDetail, MissAssessment, MissVerdict } from '@taktflow/core'
import { invalidate, RevisionConflictError, useSource } from '../../api'
import { Dialog, ReasonDialog, ReasonField, reasonOk, toast } from '../../components/ui'
import { actorName, fmtRelative } from '../../lib/format'
import { Link, navigate } from '../../lib/router'
import { ASSESSED_BY, MISS_CONDITIONS, MISS_VERDICT, MISS_VERDICT_ORDER, validityOf } from '../eval/labels'
import type { NodeIndex } from './defects-tab.attribution'
import { ConflictNotice, useReloadLatest } from './defects-tab.state'

type Cond = MissAssessment['conditions']
type CondKey = keyof Cond

/** `<runId>:<nodeId>:<attempt>:<修订>.<轮>:<主体>` → 节点与主体。 */
export function parseCheckpoint(id: string): { runId: string; nodeId: string; subject: string } {
  const parts = id.split(':')
  return { runId: parts[0] ?? '', nodeId: parts[1] ?? id, subject: parts[parts.length - 1] ?? '' }
}

function CondCell({ k, v, n, label }: { k: CondKey; v: boolean | undefined; n: string; label: string }) {
  const state = v === true ? 'yes' : v === false ? 'no' : 'unk'
  const text = v === true ? '成立' : v === false ? '不成立' : '无法判断'
  return (
    <span className={`df-cond is-${state}`} title={`${n} ${label}：${text}`} data-k={k}>
      {v === true ? <Check strokeWidth={2.6} /> : v === false ? <X strokeWidth={2.6} /> : <HelpCircle strokeWidth={2.2} />}
    </span>
  )
}

/**
 * 逐检查点的漏检结论（docs/design/21 §4）：每个相关检查点一行，五项条件逐项"成立 / 不成立 / 无法判断"附依据；
 * 预检算 ②④，auditor 给 ①③⑤ 的建议，人改判带原因，人工结论不被自动结果覆盖。
 */
/** 与后端同口径：缺陷有效、人确认"本该拦住"、五项条件全成立，才能生成必拦样本。 */
const sampleReady = (d: DefectDetail, a: MissAssessment) =>
  validityOf(d) === 'valid' && a.verdict === 'should_have_caught' && a.by === 'human' && Boolean(a.confirmed) && MISS_CONDITIONS.every((c) => a.conditions[c.key] === true)

export function MissCard({ d, idx }: { d: DefectDetail; idx: NodeIndex }) {
  const list = d.attribution?.checkpoints ?? []
  const [open, setOpen] = useState<string>()
  const [edit, setEdit] = useState<MissAssessment>()
  const [sample, setSample] = useState<MissAssessment>()
  const ds = useSource()
  if (!list.length) return null
  const counts = list.reduce<Partial<Record<MissVerdict, number>>>((m, a) => ({ ...m, [a.verdict]: (m[a.verdict] ?? 0) + 1 }), {})
  return (
    <section className="df-sec df-miss">
      <h3 className="df-h3">
        逐检查点漏检
        <span className="faint df-h3-sub">只有"本该拦住"计入检出率；证明不了的记"无法判断"</span>
      </h3>
      <div className="df-cpr-sum">
        {MISS_VERDICT_ORDER.filter((v) => counts[v]).map((v) => (
          <span key={v} className={`df-tag df-tone-${MISS_VERDICT[v].tone}`} title={MISS_VERDICT[v].hint}>
            {MISS_VERDICT[v].label} {counts[v]}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <span className="df-cond-legend faint" aria-hidden>
          {MISS_CONDITIONS.map((c) => (
            <span key={c.key}>
              {c.n}
              {c.label}
            </span>
          ))}
        </span>
      </div>
      <ul className="df-cpr-list">
        <li className="df-cpr df-cpr-th" aria-hidden>
          <div className="df-cpr-head">
            <span className="df-cpr-th-who">检查点</span>
            <span className="df-conds">
              {MISS_CONDITIONS.map((c) => (
                <span key={c.key} className="df-cond-h" title={c.label}>
                  {c.n}
                </span>
              ))}
            </span>
            <span>结论</span>
            <span>来源</span>
          </div>
        </li>
        {list.map((a, i) => {
          const p = parseCheckpoint(a.checkpointId)
          const node = idx.find(a.nodeId)
          const expanded = open === a.checkpointId
          const human = a.by === 'human'
          return (
            <li key={a.checkpointId} className={`df-cpr v-${a.verdict}${expanded ? ' open' : ''}`} style={{ '--i': i } as CSSProperties}>
              <div className="df-cpr-head">
                <button type="button" className="df-cpr-toggle" onClick={() => setOpen(expanded ? undefined : a.checkpointId)} aria-expanded={expanded}>
                  <ChevronRight className="df-cpr-caret" />
                  <span className="df-cpr-who">
                    <span className="truncate">{node?.title ?? a.nodeId}</span>
                    <span className="mono faint">{p.subject}</span>
                  </span>
                </button>
                <span className="df-conds">
                  {MISS_CONDITIONS.map((c) => (
                    <CondCell key={c.key} k={c.key} v={a.conditions[c.key]} n={c.n} label={c.label} />
                  ))}
                </span>
                <span className={`df-tag df-tone-${MISS_VERDICT[a.verdict].tone}`} title={MISS_VERDICT[a.verdict].hint}>
                  {MISS_VERDICT[a.verdict].label}
                </span>
                <span className={`df-by${human ? ' is-human' : ''}`} title={a.confirmed ? `${actorName(a.confirmed.by)} ${fmtRelative(a.confirmed.at)}` : undefined}>
                  {human && <UserRoundCheck />}
                  {ASSESSED_BY[a.by]}
                </span>
              </div>
              {expanded && (
                <div className="df-cpr-body">
                  <ul className="df-cpr-ev">
                    {a.evidence.map((e, k) => (
                      <li key={k}>{e}</li>
                    ))}
                  </ul>
                  {a.confirmed?.note && (
                    <p className="df-cpr-note">
                      <UserRoundCheck />
                      <span>
                        {actorName(a.confirmed.by)}：{a.confirmed.note}
                      </span>
                    </p>
                  )}
                  <div className="df-cpr-act">
                    <Link to={`/run/${a.runId}?node=${encodeURIComponent(a.nodeId)}&dtab=checkpoints`} className="btn btn-xs btn-ghost">
                      看检查点与快照
                      <ArrowUpRight />
                    </Link>
                    <span style={{ flex: 1 }} />
                    {sampleReady(d, a) && (
                      <button type="button" className="btn btn-xs" onClick={() => setSample(a)}>
                        <FlaskConical />
                        生成必拦样本
                      </button>
                    )}
                    <button type="button" className={`btn btn-xs${human ? '' : ' btn-primary'}`} onClick={() => setEdit(a)}>
                      <PencilLine />
                      {human ? '改判' : '确认或改判'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <MissDialog d={d} a={edit} onClose={() => setEdit(undefined)} />
      <ReasonDialog
        open={Boolean(sample)}
        onClose={() => setSample(undefined)}
        title="生成必拦样本（must_catch）"
        description={sample ? `绑定检查点 ${parseCheckpoint(sample.checkpointId).nodeId} · ${parseCheckpoint(sample.checkpointId).subject} 当时的快照；之后改评审技能或 prompt，回放这个检查点时期望它提出「${d.title}」。` : undefined}
        confirmLabel="生成"
        onSubmit={async (reason) => {
          if (!sample) return
          const c = await ds.createEvalSample({ kind: 'must_catch', checkpointId: sample.checkpointId, defectId: d.id, expectIssue: d.title, baseRevision: d.revision, reason })
          invalidate()
          toast(`已生成样本 ${c.id}`, { body: '在评测页的样本列表里，可以拿它回放比较技能或 prompt 的改动。', action: { label: '去评测页', onClick: () => navigate('/eval?tab=cases') } })
        }}
      />
    </section>
  )
}

const TRI: Array<{ v: boolean | undefined; label: string }> = [
  { v: true, label: '成立' },
  { v: false, label: '不成立' },
  { v: undefined, label: '无法判断' },
]

/** 人改判：结论 + 五项条件 + 原因；带读到的 revision，冲突时提示并可载入最新。 */
function MissDialog({ d, a, onClose }: { d: DefectDetail; a?: MissAssessment; onClose: () => void }) {
  const ds = useSource()
  const [verdict, setVerdict] = useState<MissVerdict>('undetermined')
  const [cond, setCond] = useState<Cond>({})
  const [reason, setReason] = useState('')
  const [base, setBase] = useState(d.revision ?? 1)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string>()
  useEffect(() => {
    if (!a) return
    setVerdict(a.verdict)
    setCond({ ...a.conditions })
    setReason('')
    setBase(d.revision ?? 1)
    setConflict(undefined)
    // 打开时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a])
  const [loading, reload] = useReloadLatest(d, (next) => {
    const fresh = next.attribution?.checkpoints?.find((x) => x.checkpointId === a?.checkpointId)
    if (fresh) {
      setVerdict(fresh.verdict)
      setCond({ ...fresh.conditions })
    }
    setBase(next.revision ?? 1)
    setConflict(undefined)
  })
  // 五项都成立才是"本该拦住"：选了它但条件不全时提醒
  const allYes = MISS_CONDITIONS.every((c) => cond[c.key] === true)
  const mismatch = verdict === 'should_have_caught' && !allYes
  const ok = Boolean(a) && reasonOk(reason) && !busy && !conflict
  const submit = async () => {
    if (!a || !ok) return
    setBusy(true)
    try {
      await ds.decideMiss(d.requirementId, d.id, a.checkpointId, { verdict, conditions: cond, reason: reason.trim(), baseRevision: base })
      invalidate()
      toast('已改判', { body: `${parseCheckpoint(a.checkpointId).nodeId}：${MISS_VERDICT[verdict].label}（人工结论，自动结果不会覆盖）`, tone: 'success' })
      onClose()
    } catch (e) {
      if (e instanceof RevisionConflictError) setConflict(e.message)
      else toast('改判失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  const p = a ? parseCheckpoint(a.checkpointId) : undefined
  return (
    <Dialog
      open={Boolean(a)}
      onClose={onClose}
      size="md"
      dismissible={!reason.trim()}
      title={p ? `改判：${p.nodeId} · ${p.subject}` : ''}
      description="人工结论带「人工」标记进质量日志；之后重新归因也不会覆盖它。"
      footer={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!ok} aria-busy={busy} onClick={submit}>
            {busy && <LoaderCircle className="spin" aria-hidden />}
            {a?.by === 'human' ? '提交改判' : '确认'}
          </button>
        </>
      }
    >
      <div className="ev-form">
        {conflict && <ConflictNotice message={conflict} loading={loading} onReload={reload} />}
        <div className="ev-field">
          <span className="ev-label">五项条件</span>
          <div className="df-tri-grid">
            {MISS_CONDITIONS.map((c) => (
              <div key={c.key} className="df-tri-row">
                <span className="df-tri-label">
                  {c.n} {c.label}
                </span>
                <div className="df-tri" role="radiogroup" aria-label={c.label}>
                  {TRI.map((t) => (
                    <button key={t.label} type="button" role="radio" aria-checked={cond[c.key] === t.v} className={`df-tri-opt${cond[c.key] === t.v ? ' on' : ''}`} onClick={() => setCond((x) => ({ ...x, [c.key]: t.v }))}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="ev-field">
          <span className="ev-label">结论</span>
          <div className="df-verdicts" role="radiogroup" aria-label="结论">
            {MISS_VERDICT_ORDER.map((v) => (
              <button key={v} type="button" role="radio" aria-checked={verdict === v} className={`df-verdict${verdict === v ? ' on' : ''}`} onClick={() => setVerdict(v)}>
                <span className={`df-tag df-tone-${MISS_VERDICT[v].tone}`}>{MISS_VERDICT[v].label}</span>
                <span className="faint">{MISS_VERDICT[v].hint}</span>
              </button>
            ))}
          </div>
          {mismatch && <span className="df-warn">"本该拦住"要求五项都成立；现在有不成立或无法判断的项，确认结论没选错。</span>}
        </div>
        <ReasonField value={reason} onChange={setReason} placeholder="例如：快照里确实有 csv.ts，评审职责写了边界，输出没提转义" />
      </div>
    </Dialog>
  )
}
