import type { SpaceDetail } from '@taktflow/core'
import { WorkflowTable } from '../workflows-list-table'

/** 空间设置 · Workflow：列表（标题、文件、修订、可编辑、节点数、运行数），点进 /workflows/:id 编辑器。 */
export function WorkflowsTab({ space }: { space?: SpaceDetail }) {
  const runs = space?.workflows.reduce((n, w) => n + w.runs, 0)
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">流水线</span>
        {space && (
          <span className="faint">
            <span className="num">{space.workflows.length}</span> 个 · 最近 <span className="num">{runs}</span> 次运行
          </span>
        )}
      </div>
      <WorkflowTable workflows={space?.workflows} />
    </div>
  )
}
