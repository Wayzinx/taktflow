import { Settings2 } from 'lucide-react'
import { useAsync } from '../api'
import { PageHeader, useCrumbs } from '../components/layout'
import { ErrorState } from '../components/ui'
import { Link } from '../lib/router'
import { WorkflowTable } from './workflows-list-table'

/** /workflows：当前空间的 workflow 列表（ds.workflows()），点进 /workflows/:id 编辑器。 */
export function WorkflowsListPage() {
  useCrumbs([{ label: 'Workflow' }], [])
  const q = useAsync((ds) => ds.workflows(), [])
  const editable = q.data?.filter((w) => w.editable).length
  return (
    <div className="page wf-page fade-in">
      <PageHeader
        title="Workflow"
        sub={
          q.data
            ? `空间里的流水线定义，共 ${q.data.length} 个，${editable} 个可视化编辑。修改留修订记录，可回滚。`
            : '空间里的流水线定义：可视化编辑、修订历史与回滚。'
        }
        actions={
          <Link to="/settings?tab=workflows" className="btn btn-sm">
            <Settings2 />
            空间设置
          </Link>
        }
      />
      <div className="card">
        {q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : <WorkflowTable workflows={q.data} />}
      </div>
      <p className="wf-page-foot">
        只读的 workflow 含画布无法还原的代码结构，可以看图和源码；需要改时直接编辑 <span className="mono">.workflow.ts</span> 文件。
      </p>
    </div>
  )
}
