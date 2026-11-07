import type { ReactNode } from 'react'
import type { WorkflowSummary } from '@taktflow/core'
import { ChevronRight, Lock, PencilRuler, Workflow } from 'lucide-react'
import { EmptyState, SkeletonRows } from '../components/ui'
import { fmtDate, fmtRelative } from '../lib/format'
import { Link, navigate } from '../lib/router'
import './workflows-list.css'

/** workflow 列表：整行可点，标题是真正的链接（键盘、新标签页）；renderActions 渲染行尾的操作菜单。 */
export function WorkflowTable({ workflows, defaultId, renderActions }: { workflows?: WorkflowSummary[]; defaultId?: string; renderActions?: (w: WorkflowSummary) => ReactNode }) {
  if (!workflows) return <SkeletonRows rows={3} />
  if (workflows.length === 0) {
    return (
      <EmptyState
        compact
        icon={Workflow}
        title="这个空间还没有 workflow"
        hint="从模板新建一个流程。"
      />
    )
  }
  const sorted = [...workflows].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId) || Number(b.editable) - Number(a.editable) || b.updatedAt.localeCompare(a.updatedAt))
  return (
    <div className="wf-table-wrap">
      <table className="table wf-table">
        <thead>
          <tr>
            <th>Workflow</th>
            <th>编辑</th>
            <th className="r">节点</th>
            <th className="r">最近运行</th>
            <th className="wf-col-rev">修订</th>
            <th>更新</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((w) => (
            <tr key={w.id} className="clickable" onClick={(e) => !(e.target as HTMLElement).closest('a') && navigate(`/workflows/${encodeURIComponent(w.id)}`)}>
              <td className="wf-cell-title">
                <span className="wf-title-row">
                  <Link to={`/workflows/${encodeURIComponent(w.id)}`} className="wf-title">
                    {w.title}
                  </Link>
                  {w.id === defaultId && <span className="chip wf-default">默认</span>}
                </span>
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
                  <span className="wf-mode readonly" title="定义里有画布无法还原的代码结构，只能看图或改源码">
                    <Lock aria-hidden />
                    只读
                  </span>
                )}
              </td>
              <td className="r num">{w.nodes}</td>
              <td className="r num">{w.runs ? w.runs : <span className="faint">—</span>}</td>
              <td className="wf-col-rev">
                <span className="mono wf-rev">{w.rev.slice(0, 8)}</span>
              </td>
              <td>
                <time dateTime={w.updatedAt} title={fmtDate(w.updatedAt)} className="faint">
                  {fmtRelative(w.updatedAt)}
                </time>
              </td>
              <td className="wf-cell-go" onClick={renderActions ? (e) => e.stopPropagation() : undefined}>
                {renderActions ? renderActions(w) : <ChevronRight aria-hidden />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
