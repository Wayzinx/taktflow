import type { AttentionItem, RequirementDetail, RunDetail, StewardEntitySnapshot } from '@taktflow/core'
import { useAsync } from '../../../api'
import { ActivityLine, useSteadyActivity } from '../../../components/activity-line'
import { actOf, AgentMark, harnessHue, markOf } from '../../../components/agent-mark'
import { AttentionCard, attentionMeta } from '../../../components/attention-card'
import { StageRail } from '../../../components/stage-rail'
import { useEntityFocus, type FocusTarget } from '../../../components/steward/focus'
import { cellsOf, LaneTrack } from '../../../components/viz'
import { Skeleton } from '../../../components/ui'
import { requirementLook } from '../../../lib/entity-look'
import { fmtRelative } from '../../../lib/format'
import { Link } from '../../../lib/router'
import { NODE_STATUS } from '../../../lib/status'
import { EntityFoot, SnapshotCard, TonePill, useKept, useRunEvents, useTick } from './shared'

const isLive = (s?: string) => s === 'running' || s === 'waiting_human'

/** 需求 + 当前运行（有在跑或等人的节点时才取运行图，拿 harness 与动作）+ 待办，跟着运行事件刷新。 */
export function useRequirementLive(id: string) {
  const [tick, bump] = useTick()
  const req = useAsync((ds) => ds.requirement(id), [id, tick])
  const r = useKept(req.data)
  const live = isLive(r?.current?.status)
  useRunEvents(r?.current?.runId, live, bump)
  const run = useKept(useAsync((ds) => (r?.current ? ds.run(r.current.runId) : Promise.resolve(undefined)), [r?.current?.runId, tick]).data)
  const att = useKept(useAsync((ds) => ds.attention(true), [id, tick]).data)
  const pending = (att ?? []).filter((a) => a.requirementId === id && !a.answeredAt)
  return { r, run, pending, live, error: req.error, loading: !r && req.loading }
}

function NowRow({ r, run }: { r: RequirementDetail; run?: RunDetail }) {
  const cur = r.current
  const g = cur ? run?.graph.nodes.find((n) => n.id === cur.nodeId) : undefined
  const activity = useSteadyActivity(cur?.status === 'running' ? g?.activity : undefined)
  if (!cur) return <p className="ent-note">{requirementLook(r).status}</p>
  const mark = markOf(cur.status)
  return (
    <div className="ent-now">
      <AgentMark state={mark.state} sign={mark.sign} act={actOf(activity)} hue={harnessHue(g?.harness)} size={30} />
      <div className="ent-now-main">
        <span className="ent-now-head">
          <b>{cur.title}</b>
          {g?.harness && <span className="mono faint">{g.harness}</span>}
          <span className="faint">{NODE_STATUS[cur.status].label}</span>
        </span>
        {activity && <ActivityLine activity={activity} />}
      </div>
    </div>
  )
}

/** card：标题、状态、阶段泳道、当前节点（蜂 + 在做什么）、等你决定的事（直接在卡里处理）。 */
export function RequirementCard({ id, target, snapshot, inPanel }: { id: string; target: FocusTarget; snapshot?: StewardEntitySnapshot; inPanel?: boolean }) {
  const { r, run, pending, live, error, loading } = useRequirementLive(id)
  if (error && !r) return snapshot ? <SnapshotCard snapshot={snapshot} reason="拿不到实时数据" /> : null
  if (loading || !r) return <CardSkeleton />
  const look = requirementLook(r)
  return (
    <div className="ent ent-card">
      <div className="ent-head">
        {target.ref.spaceId && <span className="ent-space">{target.ref.spaceId}</span>}
        <span className="ent-id mono">{r.id}</span>
        <b className="ent-title truncate" title={r.title}>
          {r.title}
        </b>
        <span className="ent-gap" />
        <TonePill tone={look.tone}>{look.tone === 'waiting' ? `等你 ${pending.length || r.pendingAttention}` : undefined}</TonePill>
      </div>
      {r.stages.length > 0 && (
        <div className="ent-lanes">
          <LaneTrack cells={cellsOf(r.stages)} />
          <div className="ent-lane-labels" aria-hidden>
            {r.stages.map((s) => (
              <span key={s.id} data-st={s.status} className="truncate">
                {s.title}
              </span>
            ))}
          </div>
        </div>
      )}
      <NowRow r={r} run={run} />
      {pending.slice(0, 2).map((a) => (
        <AttentionCard key={a.requestId} item={a} reqTitle={r.title} compact={!inPanel || pending.length > 1} />
      ))}
      {pending.length > 2 && <p className="ent-note">还有 {pending.length - 2} 件，在右侧或需求页处理。</p>}
      <EntityFoot target={target} live={live} at={r.updatedAt} inPanel={inPanel} />
    </div>
  )
}

/** stages：阶段轨道 + 每阶段节点计数；需求取最近一次流水线，运行取它自己的。 */
export function StagesView({ kind, id, target, snapshot, inPanel }: { kind: 'requirement' | 'run'; id: string; target: FocusTarget; snapshot?: StewardEntitySnapshot; inPanel?: boolean }) {
  const q = useAsync((ds) => (kind === 'run' ? ds.run(id).then((d) => ({ title: d.workflow.title, stages: d.stages ?? [], current: undefined, at: d.run.endedAt ?? d.run.startedAt })) : ds.requirement(id).then((r) => ({ title: r.title, stages: r.stages, current: r.current, at: r.updatedAt }))), [kind, id])
  if (q.error && !q.data) return snapshot ? <SnapshotCard snapshot={snapshot} reason="拿不到实时数据" /> : null
  const d = q.data
  if (!d) return <CardSkeleton rows={1} />
  return (
    <div className="ent">
      <div className="ent-head">
        {target.ref.spaceId && <span className="ent-space">{target.ref.spaceId}</span>}
        <span className="ent-id mono">{id}</span>
        <b className="ent-title truncate">{d.title}</b>
      </div>
      <StageRail size="sm" stages={d.stages} current={d.current} />
      <EntityFoot target={target} at={d.at} inPanel={inPanel} />
    </div>
  )
}

/** attention：需求或整个空间里等你回答 / 审批的事，原因确认照旧。 */
/** 会话里有多件待办时只列一行一件，点开在右侧面板里处理；没有面板（停靠）时直达节点。 */
function AttentionRows({ items, target }: { items: AttentionItem[]; target: FocusTarget }) {
  const focus = useEntityFocus()
  return (
    <ul className="ent-att-rows">
      {items.map((a) => {
        const m = attentionMeta(a)
        const body = (
          <>
            <span className="att-form">
              <m.icon />
              {m.label}
            </span>
            <span className="ent-id mono">{a.requirementId}</span>
            <span className="ent-att-ask truncate">{a.ask}</span>
            <time className="num">{fmtRelative(a.createdAt)}</time>
          </>
        )
        return (
          <li key={a.requestId}>
            {focus ? (
              <button type="button" className="ent-att-row" onClick={() => focus.open(target)}>
                {body}
              </button>
            ) : (
              <Link className="ent-att-row" to={`/run/${a.runId}?node=${encodeURIComponent(a.nodeId)}`}>
                {body}
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function AttentionView({ requirementId, target, inPanel }: { requirementId?: string; target: FocusTarget; inPanel?: boolean }) {
  const q = useAsync((ds) => ds.attention(true), [requirementId])
  const items = (q.data ?? []).filter((a) => !a.answeredAt && (!requirementId || a.requirementId === requirementId))
  if (q.loading && !q.data) return <CardSkeleton rows={2} />
  return (
    <div className="ent">
      <div className="ent-head">
        {target.ref.spaceId && <span className="ent-space">{target.ref.spaceId}</span>}
        <b className="ent-title">{requirementId ? `${requirementId} 等你决定的事` : '等你决定的事'}</b>
        <span className="ent-gap" />
        <TonePill tone={items.length ? 'waiting' : 'success'}>{items.length ? `${items.length} 件` : '没有了'}</TonePill>
      </div>
      {items.length === 0 ? (
        <p className="ent-note">都处理完了。</p>
      ) : !inPanel && items.length > 1 ? (
        <AttentionRows items={items.slice(0, 4)} target={target} />
      ) : (
        items.slice(0, 4).map((a) => <AttentionCard key={a.requestId} item={a} compact={items.length > 1} />)
      )}
      {items.length > 4 && <p className="ent-note">还有 {items.length - 4} 件，去待办页处理。</p>}
      <EntityFoot target={target} at={items[0]?.createdAt} inPanel={inPanel} />
    </div>
  )
}

export function CardSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="ent" aria-busy="true">
      <Skeleton w="55%" h={14} />
      <Skeleton h={8} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} w={i ? '40%' : '70%'} h={12} />
      ))}
    </div>
  )
}
