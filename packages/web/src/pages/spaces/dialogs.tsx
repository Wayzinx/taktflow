import { useEffect, useState } from 'react'
import type { SpaceSummary } from '@taktflow/core'
import { invalidate, useSource } from '../../api'
import { ColorPicker } from '../../components/space-create/basics'
import { Dialog, toast } from '../../components/ui'

/** 编辑空间：名称、描述、颜色。保存后提示可撤销（还原成改之前的值）。 */
export function EditSpaceDialog({ space, live, onClose }: { space?: SpaceSummary; live: SpaceSummary[]; onClose: () => void }) {
  const ds = useSource()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!space) return
    setName(space.name)
    setDescription(space.description ?? '')
    setColor(space.color)
    setError(undefined)
  }, [space])
  const shown = useLast(space)
  const dup = !!space && live.some((s) => s.id !== space.id && s.name === name.trim())
  const changed = !!space && (name.trim() !== space.name || description.trim() !== (space.description ?? '') || color !== space.color)
  const save = async () => {
    if (!space || !name.trim() || dup || !changed || busy) return
    setBusy(true)
    try {
      const before = { name: space.name, description: space.description ?? '', color: space.color }
      await ds.updateSpace(space.id, { name: name.trim(), description: description.trim(), color, reason: '网页编辑空间' })
      invalidate()
      onClose()
      toast(`已更新「${name.trim()}」`, { undo: () => ds.updateSpace(space.id, { ...before, reason: '撤销编辑空间' }).then(invalidate) })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={!!space}
      onClose={onClose}
      title="编辑空间"
      description={shown && <span className="mono">{shown.id}</span>}
      dismissible={!changed}
      footer={
        <>
          {error && <span className="ov-error">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={!name.trim() || dup || !changed || busy} onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      <form
        className="ov-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="ov-field">
          <span className="ov-field-label">名称</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} data-autofocus />
          {dup && <span className="sp-msg-bad">已有同名空间，换个名字</span>}
        </label>
        <label className="ov-field">
          <span className="ov-field-label">描述</span>
          <textarea className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="ov-field">
          <span className="ov-field-label">颜色</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
      </form>
    </Dialog>
  )
}

/** 彻底删除已归档空间：手动输入 id 确认；不可撤销。 */
export function DeleteSpaceDialog({ space, onClose }: { space?: SpaceSummary; onClose: () => void }) {
  const ds = useSource()
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    setConfirm('')
    setError(undefined)
  }, [space])
  const shown = useLast(space)
  const ok = !!space && confirm.trim() === space.id
  const run = async () => {
    if (!space || !ok || busy) return
    setBusy(true)
    try {
      await ds.deleteSpace(space.id, { confirm: confirm.trim(), reason: '网页彻底删除已归档空间' })
      invalidate()
      onClose()
      toast(`已彻底删除「${space.name}」`, { body: '目录与全部记录都已移除' })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={!!space}
      onClose={onClose}
      tone="danger"
      size="sm"
      title={shown ? `彻底删除「${shown.name}」` : '彻底删除'}
      description="空间目录、需求、运行记录和知识库会一起删除，无法恢复。"
      footer={
        <>
          {error && <span className="ov-error">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-danger" disabled={!ok || busy} onClick={() => void run()}>
            彻底删除
          </button>
        </>
      }
    >
      <form
        className="ov-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <label className="ov-field">
          <span className="ov-field-label">
            输入 <span className="mono sp-confirm-id">{shown?.id}</span> 确认
          </span>
          <input className="input mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus />
        </label>
      </form>
    </Dialog>
  )
}

/** 关闭（退出动画）期间继续显示最后一个对象，避免标题闪成空。 */
function useLast<T>(v: T | undefined): T | undefined {
  const [last, setLast] = useState(v)
  useEffect(() => {
    if (v) setLast(v)
  }, [v])
  return v ?? last
}
