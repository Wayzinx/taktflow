import { useEffect, useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import type { StewardBlock, StewardContextRef } from '@taktflow/core'
import { SpaceScope, useAsync } from '../../../api'
import { encodeFocus, fileFocus, focusOf, useEntityFocus, type FocusTarget } from '../../../components/steward/focus'
import { SkeletonRows } from '../../../components/ui'
import { ArtifactPreview } from '../../requirement/artifacts-tab'
import { LaneTrack } from '../../../components/viz'
import { AttentionView, RequirementCard, StagesView } from './card'
import { DagView, NodeView, RunGraph, useRunLive } from './graph'
import { SnapshotCard, TonePill } from './shared'
import './entity.css'

type EntityBlock = Extract<StewardBlock, { type: 'entity' }>
type PickBlock = Extract<StewardBlock, { type: 'pick' }>

function Body({ block, target }: { block: EntityBlock; target: FocusTarget }) {
  const { ref, snapshot } = block
  switch (block.view) {
    case 'card':
      return ref.type === 'requirement' ? <RequirementCard id={ref.id} target={target} snapshot={snapshot} /> : <SnapshotCard snapshot={snapshot} />
    case 'stages':
      return <StagesView kind={ref.type === 'run' ? 'run' : 'requirement'} id={ref.id} target={target} snapshot={snapshot} />
    case 'attention':
      return <AttentionView requirementId={ref.type === 'requirement' ? ref.id : undefined} target={target} />
    case 'dag':
      return <DagView runId={ref.id} node={block.focus} target={target} snapshot={snapshot} />
    case 'node':
      return ref.parent ? <NodeView runId={ref.parent} nodeId={ref.id} target={target} /> : <SnapshotCard snapshot={snapshot} />
    default:
      return <SnapshotCard snapshot={snapshot} />
  }
}

/**
 * 会话里的实体视图（docs/design/28 §2）：按 ref 所在空间实时取数，用页面上同一套组件画；取不到时显示服务端快照。
 * 挂上时把自己递给焦点面板（跟随中的面板会换过来）。
 */
export function EntityBlockView({ block }: { block: EntityBlock }) {
  const focus = useEntityFocus()
  const target = focusOf(block.ref, block.view === 'dag' ? block.focus : undefined)
  const key = encodeFocus(target)
  useEffect(() => {
    focus?.offer(target)
    // 同一个对象只递一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return (
    <SpaceScope spaceId={block.ref.type === 'space' ? block.ref.id : block.ref.spaceId}>
      <Body block={block} target={target} />
    </SpaceScope>
  )
}

/** pick：说的是哪一个？点一张就带着它接着问。 */
export function PickBlockView({ block, onPick }: { block: PickBlock; onPick?: (text: string, ctx: StewardContextRef[]) => void }) {
  return (
    <div className="ent-pick">
      {block.title && <div className="ent-pick-title">{block.title}</div>}
      <div className="ent-pick-grid">
        {block.items.map((c) => (
          <button key={`${c.ref.spaceId}/${c.ref.id}`} type="button" className="ent ent-mini pressable" disabled={!onPick} onClick={() => onPick?.(`就是 ${c.ref.label ?? c.ref.id}`, [c.ref])}>
            <span className="ent-head">
              {c.ref.spaceId && <span className="ent-space">{c.ref.spaceId}</span>}
              <span className="ent-id mono">{c.ref.id}</span>
              <span className="ent-gap" />
              <TonePill tone={c.snapshot.tone} />
            </span>
            <b className="ent-title truncate">{c.snapshot.title}</b>
            {c.snapshot.stages && c.snapshot.stages.length > 0 && <LaneTrack size="sm" cells={c.snapshot.stages.map((s, i) => ({ key: `${i}`, label: s.label, status: s.status }))} animate={false} />}
            <span className="ent-note truncate">
              {c.snapshot.status}
              {c.why && c.why !== c.snapshot.status ? ` · ${c.why}` : ''}
            </span>
            <CornerDownRight className="ent-pick-go" aria-hidden />
          </button>
        ))}
      </div>
    </div>
  )
}

/** 运行：图（可缩放）+ 选中节点（缺省为在跑 / 等人的那个）的详情。 */
function RunPanel({ target, onNode }: { target: FocusTarget; onNode: (node: string) => void }) {
  const { d, error } = useRunLive(target.ref.id)
  if (error && !d) return <p className="ent-note">拿不到这次运行：{error.message}</p>
  if (!d) return null
  const node = target.node ?? d.graph.nodes.find((n) => n.status === 'running' || n.status === 'waiting_human' || n.status === 'failed')?.id
  return (
    <>
      <div className="ent-panel-canvas">
        <RunGraph detail={d} selected={node} onSelect={onNode} interactive />
      </div>
      {node && <NodeView key={node} runId={target.ref.id} nodeId={node} target={{ ...target, node }} run={d} inPanel />}
    </>
  )
}

/** 需求：卡片 + 最近一次运行。 */
function RequirementPanel({ target, onNode }: { target: FocusTarget; onNode: (runId: string, node: string) => void }) {
  const r = useAsync((ds) => ds.requirement(target.ref.id), [target.ref.id])
  const runId = r.data?.current?.runId ?? r.data?.latestRunId
  return (
    <>
      <RequirementCard id={target.ref.id} target={target} inPanel />
      {runId && <RunPanel target={{ ref: { type: 'run', spaceId: target.ref.spaceId, id: runId, label: runId } }} onNode={(n) => onNode(runId, n)} />}
    </>
  )
}

/** 需求里的一个产物：和需求页「公共产物」同一个预览；版本在面板里切，点溯源换成那个文件。 */
function FilePanel({ target, onTarget }: { target: FocusTarget; onTarget: (t: FocusTarget) => void }) {
  const reqId = target.ref.parent!
  const list = useAsync((ds) => ds.artifacts(reqId), [reqId])
  const [version, setVersion] = useState<number>()
  const record = list.data?.find((r) => r.path === target.ref.id)
  if (list.error && !list.data) return <p className="ent-note">拿不到 {reqId} 的产物：{list.error.message}</p>
  if (!list.data) return <SkeletonRows rows={6} gap={10} />
  if (!record) return <p className="ent-note">{reqId} 的公共产物里没有 {target.ref.id}，可能已经移走或改名。</p>
  return <ArtifactPreview reqId={reqId} record={record} version={version} onVersion={setVersion} onOpen={(path) => onTarget(fileFocus(target.ref.spaceId!, reqId, path))} />
}

/** 焦点面板的内容：按对象类型换视图，全部在对象所在空间里取数。 */
export function EntityPanel({ target, onTarget }: { target: FocusTarget; onTarget: (t: FocusTarget) => void }) {
  const runRef = (id: string): StewardContextRef => ({ type: 'run', spaceId: target.ref.spaceId, id, label: id })
  return (
    <SpaceScope spaceId={target.ref.type === 'space' ? target.ref.id : target.ref.spaceId}>
      <div className="ent-panel">
        {target.ref.type === 'run' ? (
          <RunPanel target={target} onNode={(node) => onTarget({ ref: target.ref, node })} />
        ) : target.ref.type === 'file' && target.ref.parent ? (
          <FilePanel target={target} onTarget={onTarget} />
        ) : target.ref.type === 'requirement' ? (
          <RequirementPanel target={target} onNode={(runId, node) => onTarget({ ref: runRef(runId), node })} />
        ) : (
          <AttentionView target={target} inPanel />
        )}
      </div>
    </SpaceScope>
  )
}
