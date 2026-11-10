import type { WorkflowSummary } from '@taktflow/core'
import { ChevronRight, Lock, PencilRuler, Workflow } from 'lucide-react'
import { EmptyState, SkeletonRows, useFlashRows, useStagger } from '../components/ui'
import { fmtDate, fmtRelative } from '../lib/format'
import { Link, navigate } from '../lib/router'
import './workflows-list.css'

/** workflow 列表：/workflows 页面和空间设置的 Workflow Tab 共用。整行可点，标题是真正的链接（键盘、新标签页）。 */
export function WorkflowTable({ workflows }: { workflows?: WorkflowSummary[] }) {
  const st = useStagger(workflows?.length ?? 0)
  const flash = useFlashRows((workflows ?? []).map((w) => w.id))
  if (!workflows) return <SkeletonRows rows={3} />
  if (workflows.length === 0) {
    return (
      <EmptyState
        compact
        icon={Workflow}
        title="这个空间还没有流水线"
        body="流水线决定需求怎么交付。告诉管家你们的流程，它会生成一条可以在画布上改的流水线。"
        stewardAsk="帮我建一条标准交付流水线：需求 → 设计 → 研发 → 测试 → 交付"
      />
    )
  }
  const sorted = [...workflows].sort((a, b) => Number(b.editable) - Number(a.editable) || b.updatedAt.localeCompare(a.updatedAt))
  return (
    <div className="wf-table-wrap">
      <table className="table wf-table">
        <thead>
          <tr>
            <th>流水线</th>
            <th>编辑</th>
            <th className="r">节点</th>
            <th className="r">最近运行</th>
            <th>修订</th>
            <th>更新</th>
            <th aria-label="打开" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((w, i) => (
            <tr key={w.id} className={`clickable ${st(i).className ?? ''} ${flash(w.id)}`} style={st(i).style} onClick={(e) => !(e.target as HTMLElement).closest('a') && navigate(`/workflows/${encodeURIComponent(w.id)}`)}>
              <td className="wf-cell-title">
                <Link to={`/workflows/${encodeURIComponent(w.id)}`} className="wf-title">
                  {w.title}
                </Link>
                <span className="wf-file mono truncate" title={w.file}>
                  {w.file}
                </span>
              </td>
              <td>
                {w.editable ? (
                  <span className="wf-mode">
                    <PencilRuler aria-hidden />
                    可视化编辑
                  </span>
                ) : (
                  <span className="wf-mode readonly" title="定义里有画布无法还原的代码结构；打开后可以一键转换成可编辑格式，转换不了就让管家来改">
                    <Lock aria-hidden />
                    只读
                  </span>
                )}
              </td>
              <td className="r num">{w.nodes}</td>
              <td className="r num">{w.runs ? w.runs : <span className="faint">—</span>}</td>
              <td>
                <span className="mono wf-rev">{w.rev.slice(0, 8)}</span>
              </td>
              <td>
                <time dateTime={w.updatedAt} title={fmtDate(w.updatedAt)} className="faint">
                  {fmtRelative(w.updatedAt)}
                </time>
              </td>
              <td className="wf-cell-go">
                <ChevronRight aria-hidden />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
