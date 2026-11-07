import { useState } from 'react'
import { ArchiveRestore, ChevronRight, Trash2 } from 'lucide-react'
import type { SpaceSummary } from '@taktflow/core'
import { SpaceMark } from '../../components/space-switcher'
import { fmtRelative } from '../../lib/format'

/** 已归档区：默认收起；每行可恢复，或输入 id 确认后彻底删除。 */
export function ArchivedSpaces({ rows, flash, onRestore, onDelete }: { rows: SpaceSummary[]; flash: (id: string) => string; onRestore: (s: SpaceSummary) => void; onDelete: (s: SpaceSummary) => void }) {
  const [open, setOpen] = useState(false)
  if (!rows.length) return null
  return (
    <section className="sp-archived">
      <button type="button" className="sp-archived-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className="sp-chevron" aria-hidden />
        已归档
        <span className="num faint">{rows.length}</span>
        <span className="sp-archived-hint faint">归档的空间不出现在切换器里，可以随时恢复</span>
      </button>
      <div className="expand" data-open={String(open)}>
        <div>
          <ul className="sp-archived-list">
            {rows.map((s) => (
              <li key={s.id} className={`sp-archived-row ${flash(s.id)}`}>
                <SpaceMark space={s} size={24} />
                <span className="sp-archived-name">
                  <span className="truncate">{s.name}</span>
                  <span className="mono faint">{s.id}</span>
                </span>
                <span className="faint sp-archived-at">{s.archivedAt ? `归档于 ${fmtRelative(s.archivedAt)}` : '已归档'}</span>
                <button type="button" className="btn btn-sm" onClick={() => onRestore(s)}>
                  <ArchiveRestore />
                  恢复
                </button>
                <button type="button" className="btn btn-sm btn-ghost sp-danger" onClick={() => onDelete(s)}>
                  <Trash2 />
                  彻底删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
