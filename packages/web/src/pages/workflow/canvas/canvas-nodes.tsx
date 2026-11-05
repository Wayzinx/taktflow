import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { AlertTriangle, Code2, Repeat, Sparkles } from 'lucide-react'
import type { EditableNode } from '@taktflow/core'
import { literalOf } from '../../../api/workflow-edit'
import { KindIcon } from '../../../components/ui'
import { NODE_KIND } from '../../../lib/status'
import type { LaneData, LoopData, WfNodeData } from './build-flow'
import { titleOf } from './graph'

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Left} id="ls" className="wf-handle-hidden" isConnectable={false} />
    </>
  )
}

/** 卡片第二行：按 kind 给出最关键的一项配置。 */
function subline(n: EditableNode): string {
  const role = literalOf<string>(n.props.role)
  switch (n.kind) {
    case 'agent':
    case 'judge':
      return role ? `${NODE_KIND[n.kind].label} · ${role}` : NODE_KIND[n.kind].label
    case 'review': {
      const reviewers = literalOf<unknown[]>(n.props.reviewers)?.length ?? 0
      return `${reviewers} 位评审 · ≤${literalOf<number>(n.props.maxRounds) ?? '?'} 轮`
    }
    case 'human':
      return `人工 · ${literalOf<string>(n.props.form) ?? 'approve'}`
    case 'gate':
      return `门禁 · ${literalOf<unknown[]>(n.props.checks)?.length ?? 'ƒ'} 项检查`
    case 'planner':
      return role ? `规划 · ${role}` : '规划'
    default:
      return NODE_KIND[n.kind].label
  }
}

const codeCount = (n: EditableNode) => Object.entries(n.props).filter(([, v]) => v.kind === 'code').length

function Badges({ data }: { data: WfNodeData }) {
  const n = data.node
  const codes = codeCount(n)
  const err = data.diags.find((d) => d.severity === 'error') ?? data.diags[0]
  if (!codes && !err && !data.changed && n.kind !== 'review') return null
  return (
    <span className="wf-badges">
      {data.changed && (
        <span className="wf-badge wf-badge-changed">
          <Sparkles />
          刚修改
        </span>
      )}
      {codes > 0 && (
        <span className="wf-badge" title={`${codes} 个属性是代码值`}>
          <Code2 />
          {codes}
        </span>
      )}
      {err && (
        <span className={`wf-badge wf-badge-${err.severity}`} title={data.diags.map((d) => d.message).join('\n')}>
          <AlertTriangle />
          {err.severity === 'error' ? '错误' : '警告'}
        </span>
      )}
    </span>
  )
}

const cls = (data: WfNodeData, extra = '') =>
  ['wf-node', extra, data.selected && 'selected', data.changed && 'is-changed', data.diags.some((d) => d.severity === 'error') && 'has-error', data.diags.length > 0 && 'has-diag'].filter(Boolean).join(' ')

export function WfNodeView({ data }: NodeProps<Node<WfNodeData, 'wf'>>) {
  const n = data.node
  const t = titleOf(n)
  return (
    <div className={cls(data, `k-${n.kind}`)} title={`${t.text}\n${n.id} · ${NODE_KIND[n.kind].label}`}>
      <Handles />
      <div className="wf-node-card">
        <div className="wf-row">
          <KindIcon kind={n.kind} size={22} />
          <span className={`wf-title truncate${t.code ? ' mono wf-code-title' : ''}`}>{t.text}</span>
        </div>
        <div className="wf-row wf-sub">
          <span className="mono truncate">{n.id}</span>
          <span className="wf-node-meta truncate">{subline(n)}</span>
        </div>
      </div>
      {n.kind === 'planner' && (
        <div className="wf-planner-tray" aria-hidden>
          运行时展开 · 至多 {literalOf<number>(n.props.maxItems) ?? '?'} 项
        </div>
      )}
      <Badges data={data} />
    </div>
  )
}

export function LoopView({ data }: NodeProps<Node<LoopData, 'loop'>>) {
  const n = data.node
  const t = titleOf(n)
  const max = literalOf<number>(n.props.maxIterations)
  return (
    <div className={`wf-loop${data.selected ? ' selected' : ''}${data.changed ? ' is-changed' : ''}`} style={{ width: data.w, height: data.h }}>
      <Handles />
      <div className="wf-loop-head">
        <Repeat />
        <span className="wf-loop-title truncate">{t.text}</span>
        <span className="mono faint truncate">{n.id}</span>
        <span className="wf-badge">≤{max ?? '?'} 次</span>
      </div>
      {!n.body?.length && <div className="wf-loop-empty">把节点拖进来作为循环体</div>}
      <Badges data={data} />
    </div>
  )
}

export function LaneView({ data }: NodeProps<Node<LaneData, 'lane'>>) {
  return (
    <div className={`wf-lane${data.drop ? ' is-drop' : ''}`} style={{ height: data.h }}>
      <div className="wf-lane-head">
        <span className="wf-lane-no mono num">{String(data.index + 1).padStart(2, '0')}</span>
        <span className="wf-lane-title truncate">{data.stage.title}</span>
        <span className="mono faint">{data.stage.id}</span>
      </div>
    </div>
  )
}

export const nodeTypes = { wf: WfNodeView, loop: LoopView, lane: LaneView }
