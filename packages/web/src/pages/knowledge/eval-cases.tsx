import { useMemo, useState } from 'react'
import type { KnowledgeEvalCase, KnowledgeEvalSet } from '@taktflow/core'
import { Check, ListChecks } from 'lucide-react'
import { useSource } from '../../api'
import { EmptyState, Segmented, toast, useFlashRows, useStagger } from '../../components/ui'
import { SOURCE_META, intentLabel } from './meta'

type StatusFilter = 'all' | 'candidate' | 'active' | 'retired'
const STATUS_LABEL: Record<KnowledgeEvalCase['status'], string> = { active: '启用', candidate: '候选', retired: '退役' }

/** 用例列表：按来源 / 状态展示；候选用例批量确认或退役（可撤销）。 */
export function CaseList({ baseId, set, onSaved }: { baseId: string; set: KnowledgeEvalSet; onSaved: () => void }) {
  const ds = useSource()
  const [filter, setFilter] = useState<StatusFilter>(() => (set.cases.some((c) => c.status === 'candidate') ? 'candidate' : 'all'))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const list = useMemo(() => set.cases.filter((c) => filter === 'all' || c.status === filter), [set.cases, filter])
  const st = useStagger(list.length)
  const flash = useFlashRows(set.cases.map((c) => c.id))
  const count = (s: KnowledgeEvalCase['status']) => set.cases.filter((c) => c.status === s).length
  const candidates = list.filter((c) => c.status === 'candidate')
  const allPicked = candidates.length > 0 && candidates.every((c) => picked.has(c.id))

  async function apply(status: KnowledgeEvalCase['status']) {
    const chosen = set.cases.filter((c) => picked.has(c.id))
    if (!chosen.length) return
    setBusy(true)
    try {
      await ds.saveKnowledgeEvalCases(baseId, set.id, chosen.map((c) => ({ ...c, status })))
      setPicked(new Set())
      onSaved()
      toast(status === 'active' ? `已确认 ${chosen.length} 条用例` : `已退役 ${chosen.length} 条用例`, {
        body: status === 'active' ? '它们从下一次评测起参与发布门槛。' : undefined,
        undo: async () => (await ds.saveKnowledgeEvalCases(baseId, set.id, chosen), onSaved()),
      })
    } catch (e) {
      toast('没有保存', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className="kb-cases">
      <div className="kb-cases-bar">
        <Segmented<StatusFilter>
          size="sm"
          ariaLabel="按状态"
          value={filter}
          onChange={(f) => (setFilter(f), setPicked(new Set()))}
          options={[
            { value: 'all', label: '全部', count: set.cases.length },
            { value: 'candidate', label: '候选', count: count('candidate') },
            { value: 'active', label: '启用', count: count('active') },
            { value: 'retired', label: '退役', count: count('retired') },
          ]}
        />
        <span className="kb-spacer" />
        <div className={`kb-batch${picked.size ? ' on' : ''}`} aria-hidden={!picked.size} inert={!picked.size}>
          <span className="num">已选 {picked.size}</span>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void apply('retired')}>
            退役
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void apply('active')}>
            <Check />
            确认入库
          </button>
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyState compact icon={ListChecks} title={filter === 'candidate' ? '没有待确认的候选用例' : '这里还没有用例'} body="在检索测试里标注，或者合成 / 采集一批。" />
      ) : (
        <table className="table kb-case-table">
          <thead>
            <tr>
              <th className="kb-col-check">
                {candidates.length > 0 && <input type="checkbox" aria-label="全选候选用例" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(candidates.map((c) => c.id)))} />}
              </th>
              <th>问题</th>
              <th>来源</th>
              <th>应找到</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c, i) => {
              const s = st(i)
              const src = SOURCE_META[c.source]
              return (
                <tr key={c.id} className={`${s.className ?? ''} ${flash(c.id)}${picked.has(c.id) ? ' kb-picked' : ''}`} style={s.style}>
                  <td className="kb-col-check">{c.status === 'candidate' && <input type="checkbox" aria-label={`选择 ${c.query}`} checked={picked.has(c.id)} onChange={() => toggle(c.id)} />}</td>
                  <td>
                    <span className="kb-case-q">{c.query}</span>
                    {c.intent && <span className="faint"> · {intentLabel(c.intent)}</span>}
                  </td>
                  <td>
                    <span className="kb-tag" data-tone={src.tone} title={src.hint}>
                      {src.label}
                    </span>
                  </td>
                  <td className="mono faint kb-case-refs">{c.relevant.map((r) => r.ref).join('、') || '—'}</td>
                  <td>
                    <span className={`kb-tag${c.status === 'active' ? '' : ' quiet'}`} data-tone={c.status === 'candidate' ? 'waiting' : c.status === 'active' ? 'success' : undefined}>
                      {STATUS_LABEL[c.status]}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
