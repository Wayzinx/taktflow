import { useRef, useState } from 'react'
import { Archive, ArchiveRestore, MoreHorizontal, Trash2 } from 'lucide-react'
import type { RequirementDetail } from '@taktflow/core'
import { invalidate, useSource } from '../../api'
import { Dialog, Menu, toast } from '../../components/ui'
import { navigate } from '../../lib/router'
import { openCreateRequirement } from '../../lib/ui-store'

/** 需求页头部右侧"⋯"：归档 / 恢复 / 删除（只有没有任何运行记录的需求才能删）。 */
export function RequirementActions({ r, onChanged }: { r: RequirementDetail; onChanged: () => void }) {
  const ds = useSource()
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const archived = r.status === 'archived'
  const hasRuns = r.runs.length > 0 || !!r.latestRunId
  // 服务端对 running 与 waiting_human（等人处理）的运行都拒绝归档（409）
  const running = r.stages.some((s) => s.status === 'running') || r.runs.some((x) => x.status === 'running' || x.status === 'waiting_human') || r.pendingAttention > 0

  const archive = async () => {
    try {
      await ds.archiveRequirement(r.id, '在需求页归档')
      onChanged()
      invalidate()
      toast(`已归档 ${r.id}`, { body: r.title, undo: () => ds.restoreRequirement(r.id, '撤销归档').then(() => (onChanged(), invalidate())) })
    } catch (e) {
      toast('没能归档', { tone: 'failed', body: (e as Error).message })
    }
  }
  const restore = async () => {
    try {
      await ds.restoreRequirement(r.id, '在需求页恢复')
      onChanged()
      invalidate()
      toast(`已恢复 ${r.id}`, { undo: () => ds.archiveRequirement(r.id, '撤销恢复').then(() => (onChanged(), invalidate())) })
    } catch (e) {
      toast('没能恢复', { tone: 'failed', body: (e as Error).message })
    }
  }
  const remove = async () => {
    setBusy(true)
    try {
      await ds.deleteRequirement(r.id, '在需求页删除（没有运行记录）')
      setConfirm(false)
      invalidate()
      navigate('/requirements')
      toast(`已删除 ${r.id}`, { body: r.title, action: { label: '用原内容重建', onClick: () => openCreateRequirement({ title: r.title, description: r.description }) } })
    } catch (e) {
      toast('没能删除', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button ref={btn} type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((o) => !o)} title="更多操作">
        <MoreHorizontal />
      </button>
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        anchor={btn}
        placement="bottom-end"
        ariaLabel="需求操作"
        minWidth={220}
        items={[
          archived
            ? { id: 'restore', label: '恢复', icon: ArchiveRestore, onSelect: () => void restore() }
            : { id: 'archive', label: '归档', icon: Archive, disabled: running, hint: running ? '有进行中的运行' : undefined, onSelect: () => void archive() },
          { id: 'delete', label: '删除', icon: Trash2, danger: true, separator: true, disabled: hasRuns, hint: hasRuns ? '有运行记录，只能归档' : undefined, onSelect: () => setConfirm(true) },
        ]}
      />
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="danger"
        size="sm"
        title={`删除 ${r.id}`}
        description="这个需求还没有运行过，删除后公共存放区里的输入也一起移除，无法撤销。"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(false)} data-autofocus>
              取消
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
              删除
            </button>
          </>
        }
      >
        <p className="rh-confirm-title">{r.title}</p>
      </Dialog>
    </>
  )
}
