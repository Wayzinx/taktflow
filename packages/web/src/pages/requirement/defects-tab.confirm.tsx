import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { DefectAttribution, DefectConfirmRequest, DefectDetail, DefectOrigin, GraphNode, MissReason } from '@taktflow/core'
import { invalidate, useSource } from '../../api'
import { Dialog, toast } from '../../components/ui'
import { MISS, MISS_ORDER, ORIGIN, ORIGIN_ORDER } from '../eval/labels'

type Miss = DefectAttribution['missedBy'][number]

/** 确认（备注可选）或修改归因（备注必填，留痕）。确认后才计入成绩单与检出率，并生成回归用例。 */
export function ConfirmDialog({ mode, defect, nodes, onClose }: { mode?: 'confirm' | 'edit'; defect: DefectDetail; nodes: GraphNode[]; onClose: () => void }) {
  const ds = useSource()
  const a = defect.attribution
  const [note, setNote] = useState('')
  const [origin, setOrigin] = useState<DefectOrigin>('unknown')
  const [introNode, setIntroNode] = useState('')
  const [missed, setMissed] = useState<Miss[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!mode || !a) return
    setNote('')
    setOrigin(a.introducedAt.origin)
    setIntroNode(a.introducedAt.nodeId ?? '')
    setMissed(a.missedBy.map((m) => ({ ...m })))
    // 只在打开时取一次初值；轮询刷新 defect 不应覆盖正在编辑的表单
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, defect.id])
  const edit = mode === 'edit'
  const options = nodes.filter((n) => ['agent', 'planner', 'review', 'gate', 'judge'].includes(n.kind))
  const withCurrent = (id: string) => (id && !options.some((n) => n.id === id) ? [{ id, title: id } as GraphNode, ...options] : options)
  const ok = !busy && (!edit || note.trim().length >= 2) && (!edit || missed.every((m) => m.nodeId))

  const submit = async () => {
    if (!a || !ok) return
    const body: DefectConfirmRequest = { note: note.trim() || undefined }
    if (edit) {
      body.attribution = {
        introducedAt: { ...a.introducedAt, origin, nodeId: introNode || undefined },
        missedBy: missed.map((m) => ({ ...m, evidence: m.evidence.length ? m.evidence : ['人工修改归因'] })),
      }
    }
    setBusy(true)
    try {
      await ds.confirmDefect(defect.requirementId, defect.id, body)
      toast(edit ? '已按修改确认归因' : '已确认归因', { body: '计入成绩单与检出率，并为相关节点生成了回归评测用例。', tone: 'success' })
      invalidate()
      onClose()
    } catch (e) {
      toast('确认失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  const setMiss = (i: number, patch: Partial<Miss>) => setMissed((l) => l.map((m, j) => (j === i ? { ...m, ...patch } : m)))

  return (
    <Dialog
      open={Boolean(mode)}
      onClose={onClose}
      dismissible={!note}
      size={edit ? 'lg' : 'md'}
      title={edit ? `修改归因 · ${defect.id}` : `确认归因 · ${defect.id}`}
      description={edit ? '修改会留痕（产物版本 + 备注），备注必填。' : '确认后计入成绩单，并为引入与漏检节点生成回归用例。'}
      footer={
        <>
          <button className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-sm btn-primary" disabled={!ok} onClick={submit}>
            {busy ? '正在提交…' : edit ? '按修改确认' : '确认归因'}
          </button>
        </>
      }
    >
      <div className="ev-form">
        {edit && (
          <>
            <div className="ev-grid">
              <label className="ev-field">
                <span className="ev-label">引入类别</span>
                <select className="select input" value={origin} onChange={(e) => setOrigin(e.target.value as DefectOrigin)}>
                  {ORIGIN_ORDER.map((o) => (
                    <option key={o} value={o}>
                      {ORIGIN[o].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ev-field">
                <span className="ev-label">引入节点</span>
                <select className="select input" value={introNode} onChange={(e) => setIntroNode(e.target.value)}>
                  <option value="">（不落到具体节点）</option>
                  {withCurrent(introNode).map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title} · {n.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ev-field">
              <span className="ev-label">漏检</span>
              {missed.map((m, i) => (
                <div key={i} className="df-miss-row">
                  <select className="select input" value={m.nodeId} onChange={(e) => setMiss(i, { nodeId: e.target.value })} aria-label="漏检节点">
                    <option value="">选择节点</option>
                    {withCurrent(m.nodeId).map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title} · {n.id}
                      </option>
                    ))}
                  </select>
                  <select className="select input" value={m.reason} onChange={(e) => setMiss(i, { reason: e.target.value as MissReason })} aria-label="漏检原因">
                    {MISS_ORDER.map((r) => (
                      <option key={r} value={r}>
                        {MISS[r]}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setMissed((l) => l.filter((_, j) => j !== i))} aria-label="删除这条漏检">
                    <Trash2 />
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-ghost btn-sm df-add" onClick={() => setMissed((l) => [...l, { nodeId: '', reason: 'not_covered', evidence: [], runId: a?.introducedAt.runId }])}>
                <Plus />
                加一条漏检
              </button>
            </div>
          </>
        )}
        <label className="ev-field">
          <span className="ev-label">备注{edit ? '（必填）' : '（可选）'}</span>
          <textarea className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={edit ? '为什么改：例如"代码评审看过这段，也算漏检"' : '可以补充确认依据'} />
        </label>
      </div>
    </Dialog>
  )
}
