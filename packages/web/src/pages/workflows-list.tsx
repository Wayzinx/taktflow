import { useState } from 'react'
import { Plus, Settings2 } from 'lucide-react'
import { useAsync } from '../api'
import { useCrumbs } from '../components/layout'
import { ErrorState, PageHeader, Skeleton, useStewardSuggestions } from '../components/ui'
import { Link } from '../lib/router'
import { askSteward } from '../lib/ui-store'
import { WorkflowCreateDialog, WorkflowTable } from './workflows-list-table'
import { BeeGlyph } from '../components/identity'

/** /workflows：当前空间的 workflow 列表（ds.workflows()），点进 /workflows/:id 编辑器。 */
export function WorkflowsListPage() {
  useCrumbs([{ label: '流水线' }], [])
  const q = useAsync((ds) => ds.workflows(), [])
  const suggestions = useStewardSuggestions('workflows')
  const [creating, setCreating] = useState(false)
  const editable = q.data?.filter((w) => w.editable).length ?? 0
  const readonly = (q.data?.length ?? 0) - editable
  return (
    <div className="page wf-page wf-list-page">
      <PageHeader
        title="流水线"
        description={
          q.data ? (
            q.data.length ? (
              `${q.data.length} 条流水线，${editable} 条可以在画布上直接改${readonly ? `，${readonly} 条只读（打开后可转换）` : ''}。每次修改都留修订，可回滚。`
            ) : (
              '流水线决定需求怎么交付：先需求、再设计、再研发测试。'
            )
          ) : (
            <Skeleton w={320} h={12} style={{ marginTop: 6 }} />
          )
        }
        suggestions={suggestions}
        actions={
          <>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}><Plus />新建 / 从模板添加</button>
            <button type="button" className="btn btn-sm" onClick={() => askSteward('帮我新建一条流水线：')}>
              <BeeGlyph />
              让管家帮我
            </button>
            <Link to="/settings?tab=workflows" className="btn btn-sm btn-ghost">
              <Settings2 />
              空间设置
            </Link>
          </>
        }
      />
      <div className="card">{q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : <WorkflowTable workflows={q.data} onCreate={() => setCreating(true)} />}</div>
      {creating && <WorkflowCreateDialog open onClose={() => setCreating(false)} />}
    </div>
  )
}
