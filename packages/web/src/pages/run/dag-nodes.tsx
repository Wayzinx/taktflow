import type { CSSProperties } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { Network } from 'lucide-react'
import { ActivityLine, useSteadyActivity } from '../../components/activity-line'
import { AgentMark, actOf, harnessHue, LONG_STEP_MS, markOf } from '../../components/agent-mark'
import { KindIcon } from '../../components/ui'
import { fmtTokens, totalTokens } from '../../lib/format'
import { NODE_KIND, NODE_STATUS, STAGE_STATUS, toneSoftVar, toneVar } from '../../lib/status'
import type { DagNodeData, GroupData, LaneData } from './dag-layout'
import { ReviewBadges, ReworkTargetBadge } from './review/dag-review'

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Left} id="ls" />
    </>
  )
}

export function DagNodeView({ data }: NodeProps<Node<DagNodeData, 'dag'>>) {
  const n = data.node
  const meta = NODE_STATUS[n.status]
  const StatusIcon = meta.icon
  const tokens = totalTokens(n.usage)
  const role = n.role ? `${n.role}${n.harness ? ` · ${n.harness}` : ''}` : NODE_KIND[n.kind].label
  const sub = data.label.sub ? `${data.label.sub}${n.role ? ` · ${role}` : ''}` : role
  const showIteration = n.iteration !== undefined && !data.hideIteration
  const activity = useSteadyActivity(n.status === 'running' ? n.activity : undefined)
  const mark = markOf(n.status)
  // 长步骤在头顶加"…"：按 since 算，节点每次重渲染（SSE 节流刷新）时更新
  const long = activity && Date.now() - Date.parse(activity.since) >= LONG_STEP_MS
  return (
    <div
      data-steward-anchor={n.id}
      className={`dag-node st-${n.status} tone-${meta.tone}${data.selected ? ' selected' : ''}`}
      style={{ '--tone': toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties}
      title={`${data.label.title}\n${n.id} · ${meta.label}`}
    >
      <Handles />
      <div className="dag-row">
        {/* ux-audit: ok sign '…' 是形象头顶的符号，不是加载文案 */}
        {n.kind === 'agent' || (n.kind === 'judge' && activity) ? <AgentMark {...mark} act={actOf(activity)} sign={long ? '…' : mark.sign} hue={harnessHue(n.harness)} size={24} label={`${n.harness ?? 'Agent'} · ${meta.label}`} /> : <KindIcon kind={n.kind} size={22} />}
        <span className="dag-title truncate">{data.label.title}</span>
        <span className="dag-status" title={meta.label}>
          <StatusIcon className={meta.spin ? 'spin' : undefined} strokeWidth={2.6} />
        </span>
      </div>
      <div className="dag-row dag-sub">
        {activity ? <ActivityLine activity={activity} /> : <span className="mono truncate">{sub}</span>}
        <span style={{ flex: 1 }} />
        {tokens > 0 && !activity && <span className="mono num dag-tok">{fmtTokens(tokens)}</span>}
      </div>
      <span className="dag-badges">
        {showIteration && <span className="dag-badge">第 {n.iteration} 轮</span>}
        <ReviewBadges node={n} />
        <ReworkTargetBadge node={n} />
        {n.attempts > 1 && <span className="dag-badge warn">×{n.attempts}</span>}
      </span>
    </div>
  )
}

export function GroupView({ data }: NodeProps<Node<GroupData, 'group'>>) {
  const n = data.node
  const meta = n ? NODE_STATUS[n.status] : undefined
  const tokens = totalTokens(data.usage)
  return (
    <div
      className={`dag-group v-${data.variant}${n ? ` st-${n.status}` : ''}${data.selected ? ' selected' : ''}`}
      style={meta ? ({ '--tone': toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties) : undefined}
    >
      <Handles />
      <div className="dag-group-head">
        {n ? (
          <KindIcon kind={n.kind} size={22} />
        ) : (
          <span className="kind-icon kind-planner" style={{ width: 22, height: 22 }}>
            <Network strokeWidth={2} />
          </span>
        )}
        <span className="dag-group-title">{data.title}</span>
        {meta && (
          <span className="dag-group-status">
            <meta.icon className={meta.spin ? 'spin' : undefined} strokeWidth={2.6} />
            {meta.label}
          </span>
        )}
        {/* 轮次 / 条目上限在 workflow 定义里，RunDetail 不带，这里只显示实际值 */}
        {n?.iteration !== undefined && <span className="dag-badge">第 {n.iteration} 轮</span>}
        {data.variant === 'expand' && (
          <span className="dag-group-note truncate">
            planner 规划 {data.items} 个条目 · {data.childCount} 个节点
          </span>
        )}
        <span style={{ flex: 1 }} />
        {tokens > 0 && <span className="mono num dag-tok">{fmtTokens(tokens)}</span>}
      </div>
    </div>
  )
}

export function LaneView({ data }: NodeProps<Node<LaneData, 'lane'>>) {
  const s = data.stage
  const meta = STAGE_STATUS[s.status]
  return (
    <div className={`dag-lane st-${s.status}`} style={{ '--tone': toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties}>
      <div className="dag-lane-head">
        <span className="dag-lane-idx mono">{String(data.index).padStart(2, '0')}</span>
        <span className="dag-lane-title">{s.title}</span>
        <span className="dag-lane-status">
          <meta.icon className={meta.spin ? 'spin' : undefined} strokeWidth={2.6} />
        </span>
        <span style={{ flex: 1 }} />
        <span className="dag-lane-count mono num">
          {s.done}/{s.total}
        </span>
      </div>
    </div>
  )
}

export const nodeTypes = { dag: DagNodeView, group: GroupView, lane: LaneView }
