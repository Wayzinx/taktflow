import type { SpaceDetail } from '@taktflow/core'
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { WorkflowCreateDialog, WorkflowTable } from '../workflows-list-table'
import { ReadOnlyNote, useAccess } from './access'

/** 空间设置 · Workflow：列表（标题、文件、修订、可编辑、节点数、运行数），点进 /workflows/:id 编辑器。 */
export function WorkflowsTab({ space }: { space?: SpaceDetail }) {
  const [creating, setCreating] = useState(false)
  const access = useAccess('maintainer', '新建和修改流水线')
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
        <span className="spacer" />
        <button type="button" className="btn btn-sm" disabled={!access.ok} onClick={() => setCreating(true)}><Plus />新建 / 从模板添加</button>
      </div>
      <ReadOnlyNote why={access.why} />
      <WorkflowTable workflows={space?.workflows} onCreate={() => setCreating(true)} />
      {creating && <WorkflowCreateDialog open onClose={() => setCreating(false)} />}
    </div>
  )
}
