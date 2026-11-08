import { useState, type CSSProperties } from 'react'
import { Bug, Eye, Plus, X } from 'lucide-react'
import type { Observation, ObservationSource } from '@taktflow/core'
import { useAsync } from '../../api'
import { EmptyState, ErrorState, Segmented, SkeletonRows } from '../../components/ui'
import { actorName, fmtRelative } from '../../lib/format'
import { Link, setQuery } from '../../lib/router'
import { OBS_KIND, OBS_SOURCE, SEVERITY } from '../eval/labels'
import { parseCheckpoint } from './defects-tab.checkpoints'

type Filter = 'all' | ObservationSource

/**
 * 观察（docs/design/21 §4）：评审 / 判决 / 门禁 / 人 / 外部"在某个时刻对某个对象说了什么"，不可变、按源事件幂等入账。
 * 缺陷从观察创建（可多选）；已经挂到缺陷上的观察显示缺陷号。
 */
export function ObservationList({ requirementId, onCreate }: { requirementId: string; onCreate: (picked: Observation[]) => void }) {
  const q = useAsync((ds) => ds.observations(requirementId), [requirementId])
  const [filter, setFilter] = useState<Filter>('all')
  const [picked, setPicked] = useState<string[]>([])
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const all = q.data ?? []
  const sources = [...new Set(all.map((o) => o.source))]
  const list = all.filter((o) => filter === 'all' || o.source === filter)
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const loose = all.filter((o) => !o.defects?.length).length
  return (
    <div className="card df-obs">
      <div className="card-head">
        <span className="card-title">观察</span>
        <span className="faint num">{all.length}</span>
        {loose > 0 && <span className="faint df-obs-loose">· {loose} 条还没归到缺陷</span>}
        <span className="spacer" />
        {sources.length > 1 && (
          <Segmented<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[{ value: 'all', label: '全部' }, ...sources.map((s) => ({ value: s, label: OBS_SOURCE[s], count: all.filter((o) => o.source === s).length }))]}
          />
        )}
      </div>
      {!q.data ? (
        <SkeletonRows rows={5} />
      ) : list.length === 0 ? (
        <EmptyState icon={Eye} title="还没有观察" body="评审提出的问题、判决的失败、门禁结论和人工录入的缺陷单都会入账到这里。" />
      ) : (
        <ul className="df-obs-list">
          {list.map((o, i) => {
            const on = picked.includes(o.id)
            const cpt = o.checkpointId ? parseCheckpoint(o.checkpointId) : undefined
            return (
              <li key={o.id} className={`df-obs-row${on ? ' on' : ''}`} style={{ '--i': i } as CSSProperties}>
                <label className="df-obs-check">
                  <input type="checkbox" checked={on} onChange={() => toggle(o.id)} aria-label={`选择观察：${o.title}`} />
                </label>
                <div className="df-obs-main">
                  <div className="df-obs-top">
                    <span className="df-obs-src">{OBS_SOURCE[o.source]}</span>
                    <span className={`df-tag df-tone-${OBS_KIND[o.kind].tone}`}>{OBS_KIND[o.kind].label}</span>
                    {o.severity && o.severity in SEVERITY && <span className={`df-tag df-tone-${SEVERITY[o.severity as keyof typeof SEVERITY].tone}`}>{SEVERITY[o.severity as keyof typeof SEVERITY].label}</span>}
                    {o.severity && !(o.severity in SEVERITY) && <span className="df-tag mono">{o.severity}</span>}
                    <span className="df-obs-title truncate">{o.title}</span>
                  </div>
                  <div className="df-obs-meta faint">
                    <span>
                      {actorName(o.by)} · {fmtRelative(o.at)}
                    </span>
                    {cpt && o.runId && (
                      <Link to={`/run/${o.runId}?node=${encodeURIComponent(cpt.nodeId)}&dtab=checkpoints`} className="df-obs-cp mono" title={o.checkpointId}>
                        {cpt.nodeId} · {cpt.subject}
                      </Link>
                    )}
                    {o.subject && <span className="mono">{o.subject}</span>}
                  </div>
                </div>
                <div className="df-obs-defects">
                  {o.defects?.map((id) => (
                    <button key={id} type="button" className="df-obs-defect mono" onClick={() => setQuery({ dview: undefined, defect: id })} title="看这个缺陷">
                      <Bug />
                      {id}
                    </button>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {picked.length > 0 && (
        <div className="df-obs-bar" role="region" aria-label="已选观察">
          <span>
            已选 <b className="num">{picked.length}</b> 条
          </span>
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => setPicked([])}>
            <X />
            清除
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              onCreate(all.filter((o) => picked.includes(o.id)))
              setPicked([])
            }}
          >
            <Plus />
            用它们创建缺陷
          </button>
        </div>
      )}
    </div>
  )
}
