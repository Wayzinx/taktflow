import { useState } from 'react'
import { Activity } from 'lucide-react'
import type { EventEnvelope, RunSummary } from '@taktflow/core'
import { useAsync } from '../../api'
import { EventTimeline } from '../../components/event-timeline'
import { EmptyState, Segmented, SkeletonRows } from '../../components/ui'

type Filter = 'key' | 'all' | 'artifact' | 'human' | 'quality'

const KEY_TYPES = new Set(['run.started', 'run.finished', 'node.finished', 'node.failed', 'node.stale', 'artifact.written', 'artifact.edited', 'gate.result', 'judge.verdict', 'human.requested', 'human.answered', 'guard.violation', 'dag.expanded', 'context.compacted', 'route.decided', 'rework.started', 'review.exhausted', 'review.arbitrated', 'review.disposition', 'node.checks', 'retry.suppressed', 'budget.warning', 'budget.exhausted', 'lesson.learned'])
/** 门禁 / 判决 / 守卫，加上本轮的拦截来源：完成标准、失败指纹、评审裁决、预算。 */
const QUALITY_TYPES = new Set(['gate.result', 'judge.verdict', 'guard.violation', 'node.checks', 'retry.suppressed', 'review.exhausted', 'review.arbitrated', 'budget.warning', 'budget.exhausted'])
const ARTIFACT_TYPES = ['artifact.written', 'artifact.edited', 'artifact.untracked']
const HUMAN_TYPES = ['human.requested', 'human.answered', 'human.reminded', 'human.handed_back']
/** 除"全部"外只取这几类事件；"全部"每个运行只取最近 ALL_LAST 条。长运行的完整日志可能几百 MB（大多是 Agent 过程），不能整份下载。 */
const SHOWN_TYPES = [...new Set([...KEY_TYPES, ...QUALITY_TYPES, ...ARTIFACT_TYPES, ...HUMAN_TYPES])]
const ALL_LAST = 1000
const MATCH: Record<Filter, (e: EventEnvelope) => boolean> = {
  key: (e) => KEY_TYPES.has(e.type),
  all: () => true,
  artifact: (e) => e.type.startsWith('artifact.'),
  human: (e) => e.type.startsWith('human.'),
  quality: (e) => QUALITY_TYPES.has(e.type),
}

export function ActivityTab({ id, runs }: { id: string; runs?: RunSummary[] }) {
  const [filter, setFilter] = useState<Filter>('key')
  const [limit, setLimit] = useState(80)
  const everything = filter === 'all'
  const q = useAsync(async (ds) => {
    const all = await Promise.all((runs ?? []).map((r) => ds.events(r.runId, everything ? { last: ALL_LAST } : { types: SHOWN_TYPES })))
    return { events: all.flat().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)), truncated: everything && all.some((list) => list.length >= ALL_LAST) }
  }, [id, runs?.map((r) => r.runId).join(','), everything])
  if (!runs || !q.data) return <div className="card"><SkeletonRows rows={8} /></div>
  const events = q.data.events.filter(MATCH[filter])
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">动态</span>
        <span className="faint num">{events.length}</span>
        {q.data.truncated && <span className="faint">每个运行只取最近 {ALL_LAST} 条</span>}
        <span className="spacer" />
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'key', label: '关键事件' },
            { value: 'artifact', label: '产物' },
            { value: 'human', label: '人工' },
            { value: 'quality', label: '校验与拦截' },
            { value: 'all', label: '全部' },
          ]}
        />
      </div>
      {events.length === 0 ? (
        <EmptyState compact icon={Activity} title="没有事件" body="运行产生的每一条事件都记在只追加的哈希链日志里。" />
      ) : (
        <div style={{ padding: '10px 16px 14px' }}>
          <EventTimeline events={events.slice(0, limit)} showNode showRun={runs.length > 1} showDate />
          {events.length > limit && (
            <button className="btn btn-sm btn-ghost" style={{ marginLeft: 96 }} onClick={() => setLimit((l) => l + 120)}>
              再显示 {Math.min(120, events.length - limit)} 条
            </button>
          )}
        </div>
      )}
    </div>
  )
}
