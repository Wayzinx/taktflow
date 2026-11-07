import { useState } from 'react'
import { Code, History } from 'lucide-react'
import { literalOf } from '../../api/workflow-edit'
import { PageHeader, useCrumbs } from '../../components/layout'
import { ErrorState, Skeleton, SkeletonRows } from '../../components/ui'
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
import { AskStewardButton } from './ask-steward'
import { EditFallbackBanner } from './edit-fallback'
import { usePageContext, useWorkflowPreview } from '../../lib/ui-store'
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
  // A 组挂载点：停靠面板自动带上选中的节点；提案卡写入的幽灵预览
  usePageContext(selected ? [{ type: 'node', id: selected, parent: id, label: selected }] : [], [selected, id])
  const ghost = useWorkflowPreview(id)

  if (wf.status === 'error' && !wf.doc) return <ErrorState error={wf.error!} onRetry={() => void wf.reload()} />
  if (!wf.doc)
    return (
      <div className="page wf-page" aria-busy="true">
        <Skeleton w={220} h={22} style={{ marginBottom: 8 }} />
        <Skeleton w={260} h={12} style={{ marginBottom: 24 }} />
        <div className="wf-body" data-selected={selected ? '' : undefined}>
          <div className="card" style={{ padding: 16 }}>
            <SkeletonRows rows={6} />
          </div>
          <Skeleton h="100%" r={14} />
          <div className="card" style={{ padding: 16 }}>
            <SkeletonRows rows={5} icon={false} />
          </div>
        </div>
      </div>
    )

  return (
    <div className="page wf-page">
      <PageHeader
        title={title}
        sub={<span className="mono">{wf.doc.file}</span>}
        actions={
          <>
            <SaveStatusBar wf={wf} />
            <AskStewardButton workflowId={id} selectedNodeId={selected} />
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
      <EditFallbackBanner workflowId={id} wf={wf} />
      <RemoteChangeBanner wf={wf} onShowDiff={() => setHistory(true)} />
      <ConflictDialog wf={wf} />
      {view === 'source' ? (
        <SourceView wf={wf} />
      ) : (
        <div className="wf-body" data-selected={selected ? '' : undefined}>
          <NodePalette wf={wf} onSelect={setSelected} />
          <WorkflowCanvas wf={wf} selected={selected} onSelect={setSelected} highlight={changedNodeIds(wf.remoteChange?.before, wf.remoteChange?.after)} ghost={ghost} />
          <PropertiesPanel wf={wf} nodeId={selected} />
        </div>
      )}
      <RevisionsDrawer wf={wf} workflowId={id} open={history} onClose={() => setHistory(false)} />
    </div>
  )
}
