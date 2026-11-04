import { useState } from 'react'
import { Activity } from 'lucide-react'
import type { EventEnvelope, RunSummary } from '@taktflow/core'
import { useAsync } from '../../api'
import { EventTimeline } from '../../components/event-timeline'
import { EmptyState, Segmented, SkeletonRows } from '../../components/ui'

type Filter = 'key' | 'all' | 'artifact' | 'human' | 'quality'

const KEY_TYPES = new Set(['run.started', 'run.finished', 'node.finished', 'node.failed', 'node.stale', 'artifact.written', 'artifact.edited', 'gate.result', 'judge.verdict', 'human.requested', 'human.answered', 'guard.violation', 'dag.expanded', 'context.compacted'])
const MATCH: Record<Filter, (e: EventEnvelope) => boolean> = {
  key: (e) => KEY_TYPES.has(e.type),
  all: () => true,
  artifact: (e) => e.type.startsWith('artifact.'),
  human: (e) => e.type.startsWith('human.'),
  quality: (e) => e.type === 'gate.result' || e.type === 'judge.verdict' || e.type === 'guard.violation',
}

export function ActivityTab({ id, runs }: { id: string; runs?: RunSummary[] }) {
  const [filter, setFilter] = useState<Filter>('key')
  const [limit, setLimit] = useState(80)
  const q = useAsync(async (ds) => {
    const all = await Promise.all((runs ?? []).map((r) => ds.events(r.runId)))
    return all.flat().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
  }, [id, runs?.map((r) => r.runId).join(',')])
  if (!runs || !q.data) return <div className="card"><SkeletonRows rows={8} /></div>
  const events = q.data.filter(MATCH[filter])
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">动态</span>
        <span className="faint num">{events.length}</span>
        <span className="spacer" />
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'key', label: '关键事件' },
            { value: 'artifact', label: '产物' },
            { value: 'human', label: '人工' },
            { value: 'quality', label: '门禁 / 判决 / 守卫' },
            { value: 'all', label: '全部' },
          ]}
        />
      </div>
      {events.length === 0 ? (
        <EmptyState compact icon={Activity} title="没有事件" hint="运行产生的每一条事件都记在只追加的哈希链日志里。" />
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
