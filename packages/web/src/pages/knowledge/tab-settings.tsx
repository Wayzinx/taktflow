import { useMemo, useState } from 'react'
import type { KnowledgeBaseDetail, KnowledgeIntent, KnowledgeRetrieval } from '@taktflow/core'
import { Trash2 } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { ReasonDialog, SkeletonText, toast } from '../../components/ui'
import { navigate } from '../../lib/router'
import { AccessCard } from './settings-access'
import { INTENTS, autoReason } from './meta'
import { SchemaForm, type Schema } from './schema-form'
import { compactConfig } from './schema-config'

type Form = { name: string; description: string; intents: KnowledgeIntent[]; config: Record<string, unknown>; retrieval: KnowledgeRetrieval }
const fromBase = (b: KnowledgeBaseDetail): Form => ({ name: b.name, description: b.description, intents: b.intents, config: b.config, retrieval: b.retrieval })

/** 设置：按 schema 生成的表单、检索参数、访问控制、危险操作。改动攒在底部保存条里，一次保存。 */
export function SettingsTab({ base, reload }: { base: KnowledgeBaseDetail; reload: () => void }) {
  const ds = useSource()
  const kinds = useAsync((d) => d.knowledgeKinds(), [])
  const [form, setForm] = useState<Form>(() => fromBase(base))
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const dirty = JSON.stringify(form) !== JSON.stringify(fromBase(base))
  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }))
  const setR = (p: Partial<KnowledgeRetrieval>) => setForm((f) => ({ ...f, retrieval: { ...f.retrieval, ...p } }))
  const schema = useMemo(() => {
    const s = kinds.data?.find((k) => k.kind === base.kind)?.configSchema as Schema | undefined
    if (!s) return undefined
    // 数据源在"数据源"Tab 里管
    const { sources: _drop, ...rest } = s.properties ?? {}
    return { ...s, properties: rest, required: s.required?.filter((k) => k !== 'sources') }
  }, [kinds.data, base.kind])

  async function save() {
    setBusy(true)
    const prev = fromBase(base)
    try {
      await ds.updateKnowledgeBase(base.id, { ...form, config: compactConfig(form.config), reason: autoReason('修改设置') })
      reload()
      toast('设置已保存', { body: '检索参数立即生效；数据源配置下次构建生效。', undo: async () => (await ds.updateKnowledgeBase(base.id, { ...prev, reason: autoReason('撤销设置修改') }), reload(), setForm(prev)) })
    } catch (e) {
      toast('没有保存', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const hybrid = form.retrieval.hybrid ?? { bm25: 0.5, vector: 0.5 }
  return (
    <div className="kb-settings">
      <section className="kb-section">
        <h2 className="kb-h2">基本</h2>
        <div className="ov-form">
          <div className="kb-row-2">
            <label className="ov-field">
              <span className="ov-field-label">名字</span>
              <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <div className="ov-field">
              <span className="ov-field-label">能回答的问题</span>
              <div className="kb-intent-toggles" role="group" aria-label="能回答的问题">
                {INTENTS.map((i) => {
                  const on = form.intents.includes(i.id)
                  return (
                    <button key={i.id} type="button" className={`kb-toggle pressable${on ? ' on' : ''}`} aria-pressed={on} title={i.hint} onClick={() => set({ intents: on ? form.intents.filter((x) => x !== i.id) : [...form.intents, i.id] })}>
                      {i.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
          <label className="ov-field">
            <span className="ov-field-label">说明<span className="ov-field-hint">路由器按它判断该不该查这个库</span></span>
            <textarea className="textarea" rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </label>
        </div>
      </section>

      <section className="kb-section">
        <h2 className="kb-h2">连接与解析</h2>
        {schema ? <SchemaForm kind={base.kind} schema={schema} value={form.config} onChange={(config) => set({ config })} files={[]} onFiles={() => undefined} baseId={base.id} /> : <SkeletonText lines={3} />}
      </section>

      <section className="kb-section">
        <h2 className="kb-h2">检索参数</h2>
        <div className="kb-row-3">
          <label className="ov-field">
            <span className="ov-field-label">topK</span>
            <input className="input num" type="number" min={1} max={50} value={form.retrieval.topK} onChange={(e) => setR({ topK: Number(e.target.value) })} />
          </label>
          <label className="ov-field">
            <span className="ov-field-label">minScore<span className="ov-field-hint">低于它的命中丢弃</span></span>
            <input className="input num" type="number" min={0} max={1} step={0.05} value={form.retrieval.minScore ?? 0} onChange={(e) => setR({ minScore: Number(e.target.value) })} />
          </label>
          <label className="ov-field">
            <span className="ov-field-label">上下文预算（tokens）</span>
            <input className="input num" type="number" step={200} value={form.retrieval.budgetTokens} onChange={(e) => setR({ budgetTokens: Number(e.target.value) })} />
          </label>
        </div>
        {base.kind === 'rag' && (
          <div className="kb-row-2">
            <label className="ov-field">
              <span className="ov-field-label">
                混合权重<span className="ov-field-hint num">BM25 {hybrid.bm25.toFixed(2)} · 向量 {hybrid.vector.toFixed(2)}</span>
              </span>
              <input type="range" className="kb-range" min={0} max={1} step={0.05} value={hybrid.bm25} onChange={(e) => setR({ hybrid: { bm25: Number(e.target.value), vector: Math.round((1 - Number(e.target.value)) * 100) / 100 } })} aria-label="BM25 权重" />
            </label>
            <label className="ov-field">
              <span className="ov-field-label">rerank</span>
              <select className="select" value={form.retrieval.rerank ?? ''} onChange={(e) => setR({ rerank: e.target.value || undefined })}>
                <option value="">不 rerank</option>
                <option value="bge-reranker">bge-reranker</option>
              </select>
            </label>
          </div>
        )}
      </section>

      <AccessCard base={base} />

      <section className="kb-section kb-danger">
        <h2 className="kb-h2">危险操作</h2>
        <div className="kb-danger-row">
          <span>
            <strong>删除知识库</strong>
            <span className="faint">配置、评测集和构建产物都会删除，绑定它的空间不再能查到。</span>
          </span>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
            <Trash2 />
            删除
          </button>
        </div>
      </section>

      <div className="kb-savebar" data-open={dirty} aria-hidden={!dirty} inert={!dirty}>
        <span>有未保存的修改</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm(fromBase(base))}>
          放弃
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()}>
          保存
        </button>
      </div>

      <ReasonDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        risk="dangerous"
        title={`删除 ${base.name}`}
        description="不可撤销。绑定它的空间会立即查不到。"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await ds.deleteKnowledgeBase(base.id, reason)
          toast(`已删除 ${base.name}`)
          navigate('/knowledge')
        }}
      />
    </div>
  )
}
