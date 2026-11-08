import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw, SlidersHorizontal } from 'lucide-react'
import type { Defect, DefectDetail } from '@taktflow/core'
import { invalidate, RevisionConflictError, useSource } from '../../api'
import { Dialog, ReasonField, reasonOk, toast } from '../../components/ui'
import { setQuery } from '../../lib/router'
import { RESOLUTION, resolutionOf, VALIDITY, validityOf } from '../eval/labels'

type Validity = NonNullable<Defect['validity']>
type Resolution = NonNullable<Defect['resolution']>

function Tag({ meta, title }: { meta: { label: string; tone: string }; title?: string }) {
  return (
    <span className={`df-tag df-tone-${meta.tone}`} title={title}>
      {meta.label}
    </span>
  )
}

/** 有效性与处理状态分开两枚标签（docs/design/21 §4）；重复的带上"→ D-x"。 */
export function StateTags({ d, link = true }: { d: Defect; link?: boolean }) {
  const v = validityOf(d)
  const r = resolutionOf(d)
  return (
    <span className="df-state">
      <Tag meta={VALIDITY[v]} title={VALIDITY[v].hint} />
      {v === 'duplicate' && d.duplicateOf && !link ? (
        <span className="df-dup mono">→ {d.duplicateOf}</span>
      ) : v === 'duplicate' && d.duplicateOf ? (
        <button type="button" className="df-dup mono" onClick={() => setQuery({ defect: d.duplicateOf })} title="看被重复的缺陷">
          → {d.duplicateOf}
        </button>
      ) : (
        v !== 'not_defect' && <Tag meta={RESOLUTION[r]} title={RESOLUTION[r].hint} />
      )}
    </span>
  )
}

/**
 * 写冲突（baseRevision 不符）："别人刚改过"，给"载入最新"。
 * 载入后由调用方把表单重置到最新值，并说明变了什么。
 */
export function ConflictNotice({ message, loading, onReload }: { message: string; loading?: boolean; onReload: () => void }) {
  return (
    <div className="df-conflict" role="alert">
      <RefreshCw />
      <span>
        <b>别人刚改过。</b>
        {message}
      </span>
      <button type="button" className="btn btn-xs" disabled={loading} onClick={onReload}>
        {loading && <LoaderCircle className="spin" aria-hidden />}
        载入最新
      </button>
    </div>
  )
}

/**
 * 载入最新：invalidate 后等 d 的 revision 变化（列表重新拉到了）再回调。
 * 返回 [loading, reload]。
 */
export function useReloadLatest(d: DefectDetail, onLoaded: (next: DefectDetail) => void): [boolean, () => void] {
  const [loading, setLoading] = useState(false)
  const want = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (want.current === undefined || d.revision === want.current) return
    want.current = undefined
    setLoading(false)
    onLoaded(d)
    // onLoaded 每次渲染都是新函数，只跟 revision 走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.revision])
  return [
    loading,
    () => {
      want.current = d.revision
      setLoading(true)
      invalidate()
    },
  ]
}

const VALIDITY_OPTS = Object.keys(VALIDITY) as Validity[]
const RESOLUTION_OPTS = Object.keys(RESOLUTION) as Resolution[]

function Choice<T extends string>({ label, value, options, meta, onChange }: { label: string; value: T; options: T[]; meta: Record<T, { label: string; hint: string }>; onChange: (v: T) => void }) {
  return (
    <div className="ev-field">
      <span className="ev-label">{label}</span>
      <div className="df-choice" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} className={`df-choice-opt${value === o ? ' on' : ''}`} onClick={() => onChange(o)} title={meta[o].hint}>
            {meta[o].label}
          </button>
        ))}
      </div>
      <span className="faint df-choice-hint">{meta[value].hint}</span>
    </div>
  )
}

/** 改有效性 / 处理状态：带读到的 revision，冲突时提示并可载入最新。 */
export function StateDialog({ open, onClose, d, others }: { open: boolean; onClose: () => void; d: DefectDetail; others: DefectDetail[] }) {
  const ds = useSource()
  const [validity, setValidity] = useState<Validity>(validityOf(d))
  const [resolution, setResolution] = useState<Resolution>(resolutionOf(d))
  const [dup, setDup] = useState(d.duplicateOf ?? '')
  const [base, setBase] = useState(d.revision ?? 1)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string>()
  const [loaded, setLoaded] = useState<string>()
  // 打开 / 上次载入时看到的值：载入最新后据此说明"别人改了什么"
  const seen = useRef({ validity: validityOf(d), resolution: resolutionOf(d) })
  useEffect(() => {
    if (!open) return
    setValidity(validityOf(d))
    setResolution(resolutionOf(d))
    setDup(d.duplicateOf ?? '')
    setBase(d.revision ?? 1)
    setReason('')
    setConflict(undefined)
    setLoaded(undefined)
    seen.current = { validity: validityOf(d), resolution: resolutionOf(d) }
    // 打开时取一次当前值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const [loading, reload] = useReloadLatest(d, (next) => {
    const changes = [
      validityOf(next) !== seen.current.validity && `有效性 → ${VALIDITY[validityOf(next)].label}`,
      resolutionOf(next) !== seen.current.resolution && `处理状态 → ${RESOLUTION[resolutionOf(next)].label}`,
    ].filter(Boolean)
    seen.current = { validity: validityOf(next), resolution: resolutionOf(next) }
    setValidity(validityOf(next))
    setResolution(resolutionOf(next))
    setDup(next.duplicateOf ?? '')
    setBase(next.revision ?? 1)
    setConflict(undefined)
    setLoaded(`已载入第 ${next.revision ?? 1} 版${changes.length ? `：${changes.join('，')}` : ''}。看过之后再提交。`)
  })
  const changed = validity !== validityOf(d) || resolution !== resolutionOf(d) || (validity === 'duplicate' && dup !== (d.duplicateOf ?? ''))
  const ok = changed && reasonOk(reason) && (validity !== 'duplicate' || Boolean(dup)) && !busy && !conflict
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    try {
      await ds.updateDefect(d.requirementId, d.id, { validity, resolution, duplicateOf: validity === 'duplicate' ? dup : undefined, baseRevision: base, reason: reason.trim() })
      invalidate()
      toast(`已更新 ${d.id}`, { body: `${VALIDITY[validity].label} · ${RESOLUTION[resolution].label}`, tone: 'success' })
      onClose()
    } catch (e) {
      if (e instanceof RevisionConflictError) setConflict(e.message)
      else toast('更新失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!reason.trim()}
      title={`改 ${d.id} 的状态`}
      description="有效性（是不是缺陷）和处理状态（修没修好）分开记；都进质量日志。"
      footer={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!ok} aria-busy={busy} onClick={submit}>
            {busy && <LoaderCircle className="spin" aria-hidden />}
            提交
          </button>
        </>
      }
    >
      <div className="ev-form">
        {conflict && <ConflictNotice message={conflict} loading={loading} onReload={reload} />}
        {loaded && !conflict && <p className="df-loaded">{loaded}</p>}
        <Choice label="有效性" value={validity} options={VALIDITY_OPTS} meta={VALIDITY} onChange={setValidity} />
        {validity === 'duplicate' && (
          <label className="ev-field">
            <span className="ev-label">和哪个缺陷重复</span>
            <select className="select" value={dup} onChange={(e) => setDup(e.target.value)}>
              <option value="">选择缺陷</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id} · {o.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {validity !== 'not_defect' && validity !== 'duplicate' && <Choice label="处理状态" value={resolution} options={RESOLUTION_OPTS} meta={RESOLUTION} onChange={setResolution} />}
        <ReasonField value={reason} onChange={setReason} placeholder="例如：fix-code 第 2 轮已改，回归用例 TC-EXP-003 通过" />
      </div>
    </Dialog>
  )
}

export function StateButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn-xs btn-ghost" onClick={onClick} title="改有效性 / 处理状态">
      <SlidersHorizontal />
      改状态
    </button>
  )
}
