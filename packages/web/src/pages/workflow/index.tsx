import { useState } from 'react'
import { Code, History, Lock } from 'lucide-react'
import { literalOf } from '../../api/workflow-edit'
import { PageHeader, useCrumbs } from '../../components/layout'
import { TaktLoader } from '../../components/takt'
import { ErrorState } from '../../components/ui'
import { WorkflowCanvas } from './canvas/workflow-canvas'
import { changedNodeIds } from './collab/changed-nodes'
import { ConflictDialog } from './collab/conflict-dialog'
import { RemoteChangeBanner } from './collab/remote-change-banner'
import { RevisionsDrawer } from './collab/revisions-drawer'
import { SaveStatusBar } from './collab/save-status'
import { SourceView } from './collab/source-view'
import { NodePalette } from './palette/node-palette'
import { PropertiesPanel } from './properties/properties-panel'
import { useWorkflowDocument } from './state'
import './workflow.css'

/**
 * /workflows/:id 编辑器外壳：顶栏（保存状态、撤销重做、源码 / 历史切换）+ 节点面板 | 画布 | 属性面板。
 * D 负责布局与画布三件套；collab/** 的组件由 E 实现，这里只按约定的 props 组装。
 */
export function WorkflowEditorPage({ id }: { id: string }) {
  const wf = useWorkflowDocument(id)
  const [selected, setSelected] = useState<string>()
  const [view, setView] = useState<'canvas' | 'source'>('canvas')
  const [history, setHistory] = useState(false)
  const title = literalOf<string>(wf.model?.meta.title) ?? id
  useCrumbs([{ label: 'Workflow', to: '/workflows' }, { label: <span className="mono">{id}</span> }], [id])

  if (wf.status === 'error' && !wf.doc) return <ErrorState error={wf.error!} onRetry={() => void wf.reload()} />
  if (!wf.doc) return <TaktLoader label="正在读取 workflow" />

  return (
    <div className="page wf-page fade-in">
      <PageHeader
        title={title}
        sub={<span className="mono">{wf.doc.file}</span>}
        actions={
          <>
            <SaveStatusBar wf={wf} />
            <button className="btn btn-sm" onClick={() => setView(view === 'canvas' ? 'source' : 'canvas')} aria-pressed={view === 'source'}>
              <Code />
              源码
            </button>
            <button className="btn btn-sm" onClick={() => setHistory(true)}>
              <History />
              修订历史
            </button>
          </>
        }
      />
      {wf.readOnly && (
        <div className="card wf-readonly" role="note">
          <Lock />
          {wf.readOnlyReason}
        </div>
      )}
      <RemoteChangeBanner wf={wf} onShowDiff={() => setHistory(true)} />
      <ConflictDialog wf={wf} />
      {view === 'source' ? (
        <SourceView wf={wf} />
      ) : (
        <div className="wf-body">
          <NodePalette wf={wf} onSelect={setSelected} />
          <WorkflowCanvas wf={wf} selected={selected} onSelect={setSelected} highlight={changedNodeIds(wf.remoteChange?.before, wf.remoteChange?.after)} />
          <PropertiesPanel wf={wf} nodeId={selected} />
        </div>
      )}
      <RevisionsDrawer wf={wf} workflowId={id} open={history} onClose={() => setHistory(false)} />
    </div>
  )
}
