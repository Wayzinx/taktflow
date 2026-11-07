import { useEffect, useState } from 'react'
import type { KnowledgeBaseSummary, KnowledgeEvalRun, KnowledgeEvalSet, KnowledgeEvalVariant } from '@taktflow/core'
import { Plus, X } from 'lucide-react'
import { useSource } from '../../api'
import { Dialog, Segmented } from '../../components/ui'

export function defaultVariants(base: KnowledgeBaseSummary): KnowledgeEvalVariant[] {
  const out: KnowledgeEvalVariant[] = []
  if (base.version) out.push({ id: `v${base.version}`, label: `已发布 v${base.version}`, version: base.version })
  if (base.candidateVersion) out.push({ id: `v${base.candidateVersion}`, label: `候选 v${base.candidateVersion}`, version: base.candidateVersion })
  return out
}

/** 一个变体：版本 + 可选参数覆盖（topK、BM25 权重、rerank）。 */
function VariantRow({ v, versions, onChange, onRemove, baseline }: { v: KnowledgeEvalVariant; versions: number[]; onChange: (v: KnowledgeEvalVariant) => void; onRemove?: () => void; baseline: boolean }) {
  const r = v.retrieval ?? {}
  const setR = (p: Partial<NonNullable<KnowledgeEvalVariant['retrieval']>>) => onChange({ ...v, retrieval: { ...r, ...p } })
  return (
    <li className="kb-variant">
      <div className="kb-variant-head">
        <span className="kb-tag" data-tone={baseline ? undefined : 'running'}>
          {baseline ? '基线' : '对比'}
        </span>
        <input className="input" value={v.label} onChange={(e) => onChange({ ...v, label: e.target.value })} aria-label="变体名" />
        <select className="select kb-variant-ver" value={v.version ?? ''} onChange={(e) => onChange({ ...v, version: e.target.value ? Number(e.target.value) : undefined })} aria-label="索引版本">
          {versions.map((n) => (
            <option key={n} value={n}>
              v{n}
            </option>
          ))}
        </select>
        {onRemove && (
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="移除变体" onClick={onRemove}>
            <X />
          </button>
        )}
      </div>
      <div className="kb-variant-params">
        <label className="kb-inline">
          <span className="faint">topK</span>
          <input className="input num" type="number" min={1} max={50} value={r.topK ?? ''} placeholder="默认" onChange={(e) => setR({ topK: e.target.value ? Number(e.target.value) : undefined })} />
        </label>
        <label className="kb-inline">
          <span className="faint">BM25 权重</span>
          <input className="input num" type="number" min={0} max={1} step={0.1} value={r.hybrid?.bm25 ?? ''} placeholder="默认" onChange={(e) => setR({ hybrid: e.target.value ? { bm25: Number(e.target.value), vector: Math.round((1 - Number(e.target.value)) * 10) / 10 } : undefined })} />
        </label>
        <label className="kb-check">
          <input type="checkbox" checked={!!r.rerank} onChange={(e) => setR({ rerank: e.target.checked ? 'bge-reranker' : undefined })} />
          rerank
        </label>
      </div>
    </li>
  )
}

export function EvalRunDialog({ base, sets, open, extra, onClose, onStarted }: { base: KnowledgeBaseSummary; sets: KnowledgeEvalSet[]; open: boolean; extra?: KnowledgeEvalVariant; onClose: () => void; onStarted: (r: KnowledgeEvalRun) => void }) {
  const ds = useSource()
  const versions = [...new Set([base.version, base.candidateVersion].filter((x): x is number => !!x))]
  const [setId, setSetId] = useState(sets[0]?.id ?? '')
  const [variants, setVariants] = useState<KnowledgeEvalVariant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!open) return
    const d = defaultVariants(base)
    setVariants(extra ? [d[d.length - 1] ?? { id: 'base', label: '当前', version: versions[0] }, extra] : d)
    setSetId((s) => s || sets[0]?.id || '')
    setError(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, extra])
  const add = () => setVariants((vs) => [...vs, { id: `var-${Date.now().toString(36)}`, label: `变体 ${vs.length + 1}`, version: versions[versions.length - 1] }])

  async function start() {
    setBusy(true)
    try {
      onStarted(await ds.startKnowledgeEvalRun(base.id, { setId, variants }))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const active = sets.find((s) => s.id === setId)?.cases.filter((c) => c.status === 'active').length ?? 0
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="发起评测"
      description="在同一个评测集上按用例成对比较；第一个变体是基线。"
      footer={
        <>
          {error && <span className="ov-error">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !setId || !variants.length} onClick={() => void start()}>
            开始评测
          </button>
        </>
      }
    >
      <div className="ov-form">
        <div className="ov-field">
          <span className="ov-field-label">
            评测集<span className="ov-field-hint num">{active} 条启用用例参与</span>
          </span>
          <Segmented size="sm" ariaLabel="评测集" value={setId} onChange={setSetId} options={sets.map((s) => ({ value: s.id, label: s.title, count: s.cases.length }))} />
        </div>
        <div className="ov-field">
          <span className="ov-field-label">变体</span>
          <ul className="kb-variants">
            {variants.map((v, i) => (
              <VariantRow key={v.id} v={v} versions={versions} baseline={i === 0} onChange={(nv) => setVariants((vs) => vs.map((x) => (x.id === v.id ? nv : x)))} onRemove={variants.length > 1 ? () => setVariants((vs) => vs.filter((x) => x.id !== v.id)) : undefined} />
            ))}
          </ul>
          <button type="button" className="btn btn-sm btn-ghost kb-add-variant" onClick={add}>
            <Plus />
            添加变体（版本或参数覆盖）
          </button>
        </div>
      </div>
    </Dialog>
  )
}
