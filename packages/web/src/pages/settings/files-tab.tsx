import { useEffect, useState, type KeyboardEvent } from 'react'
import { FileText, Save } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import type { SpaceFileKind } from '../../api/source'
import { ErrorState, SkeletonRows, toast } from '../../components/ui'
import './space-files.css'

/** 粗略的改动行数：按行号逐行比较，够用来提示"改了多少"。 */
function changedLines(a: string, b: string): number {
  const x = a.split('\n')
  const y = b.split('\n')
  let n = Math.abs(x.length - y.length)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++
  return n
}

/**
 * 角色 / 技能的源文件编辑器（设置页“高级 · 查看源文件”）。表单覆盖不到的字段在这里改；
 * 保存同样要写原因、进修改记录。
 */
export function FileEditor({ kind, name, onSaved }: { kind: SpaceFileKind; name: string; onSaved?: () => void }) {
  const ds = useSource()
  const q = useAsync((d) => d.spaceFile(kind, name), [kind, name])
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const original = q.data?.content
  useEffect(() => {
    if (original !== undefined) setText(original)
    setReason('')
  }, [original])

  const changed = original === undefined ? 0 : changedLines(original, text)

  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data) return <SkeletonRows rows={10} />
  const canSave = changed > 0 && reason.trim() !== '' && !busy

  async function save() {
    if (!canSave) return
    setBusy(true)
    try {
      await ds.saveSpaceFile(kind, name, { content: text, reason: reason.trim() })
      toast(`已保存 ${q.data!.path}`, { body: `原因：${reason.trim()}。` })
      q.reload()
      onSaved?.()
    } catch (e) {
      toast('保存失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="file-editor"
      onKeyDown={(e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          void save()
        }
      }}
    >
      <div className="file-editor-head">
        <FileText aria-hidden />
        <span className="mono truncate">{q.data.path}</span>
        <span className="spacer" />
        {changed > 0 ? <span className="file-dirty">改动 <span className="num">{changed}</span> 行</span> : <span className="faint">未修改</span>}
      </div>
      <textarea className="textarea mono file-text" spellCheck={false} aria-label={`${q.data.path} 内容`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="file-save">
        <label className="grow">
          <span className="field-label">修改原因（必填，写进修改记录）</span>
          <input className="input" placeholder={changed ? '例如：补充舍入方式示例' : '修改内容后填写'} value={reason} onChange={(e) => setReason(e.target.value)} disabled={changed === 0} aria-required />
        </label>
        <button className="btn" onClick={() => setText(original ?? '')} disabled={changed === 0 || busy}>
          还原
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!canSave} title="⌘S / Ctrl+S">
          <Save />
          保存
        </button>
      </div>
    </div>
  )
}
