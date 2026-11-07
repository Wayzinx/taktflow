import { useState } from 'react'
import { Lightbulb } from 'lucide-react'
import type { Lesson, SpaceDetail } from '@taktflow/core'
import { useAsync } from '../../api'
import { EmptyState, ErrorState, Segmented, SkeletonRows, TabPanel, useStagger } from '../../components/ui'
import { LessonDetail } from './lesson-detail'
import { LESSON_ORDER, LESSON_STATUS, type LessonStatus } from './lesson-meta'
import { LessonRatio, TriggerChips } from './lesson-parts'
import './lessons.css'

type Filter = 'all' | LessonStatus

/**
 * 设置页"经验"Tab：经验列表（状态、触发条件、召回 / 帮助 / 坑），右侧详情预览正文并改状态；
 * 改状态必须写原因（ds.updateLesson）。经验只影响 prompt 注入，不改门禁、不改 workflow。
 */
export function LessonsTab({ space }: { space?: SpaceDetail }) {
  const q = useAsync((ds) => ds.lessons(), [space?.id])
  const [filter, setFilter] = useState<Filter>('all')
  const [picked, setPicked] = useState<string>()
  const [local, setLocal] = useState<Record<string, Lesson>>({})
  const st = useStagger(q.data?.length ?? 0)

  if (q.error && !q.data) return <div className="card"><ErrorState error={q.error} onRetry={q.reload} /></div>
  if (!q.data) return <div className="card"><SkeletonRows rows={5} /></div>

  const all = q.data.map((l) => local[l.id] ?? l)
  const count = (s: LessonStatus) => all.filter((l) => l.status === s).length
  const list = (filter === 'all' ? all : all.filter((l) => l.status === filter)).sort((a, b) => LESSON_ORDER.indexOf(a.status) - LESSON_ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt))
  const current = list.find((l) => l.id === picked) ?? list[0]

  if (all.length === 0)
    return (
      <div className="card">
        <EmptyState icon={Lightbulb} title="经验库是空的" body="判决、评审打回和群里明确写下的做法会自动沉淀成经验，试用通过后才会稳定召回。" stewardAsk="把我们团队的这条做法记成经验：" />
      </div>
    )

  return (
    <div className="lessons">
      <div className="card lessons-list-card">
        <div className="card-head">
          <span className="card-title">经验</span>
          <span className="faint num">{all.length}</span>
          <span className="spacer" />
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: '全部', count: all.length },
              ...LESSON_ORDER.map((s) => ({ value: s, label: LESSON_STATUS[s].label, count: count(s) })),
            ]}
            size="sm"
            ariaLabel="按状态筛选"
          />
        </div>
        {list.length === 0 ? (
          <EmptyState compact icon={Lightbulb} title={`没有${filter === 'all' ? '' : LESSON_STATUS[filter].label}的经验`} body="换个状态看看。" action={<button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button>} />
        ) : (
          <ul className="lesson-list" aria-label="经验列表">
            {list.map((l, i) => {
              const meta = LESSON_STATUS[l.status]
              const Icon = meta.icon
              const on = l.id === current?.id
              return (
                <li key={l.id} {...st(i)}>
                  <button className={`lesson-row${on ? ' is-on' : ''}${l.status === 'retired' ? ' is-retired' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => setPicked(l.id)}>
                    <span className={`lesson-status tone-${meta.tone}`} title={`${meta.label}：${meta.hint}`}>
                      <Icon aria-hidden />
                      {meta.label}
                    </span>
                    <span className="lesson-row-main">
                      <span className="lesson-row-title truncate">{l.title}</span>
                      <TriggerChips trigger={l.trigger} max={3} />
                    </span>
                    <span className="lesson-row-stats" title={`召回 ${l.stats.recalled} · 帮助 ${l.stats.helped} · 坑 ${l.stats.hurt}`}>
                      <span className="num">
                        {l.stats.helped}
                        <span className="faint">/{l.stats.recalled}</span>
                        {l.stats.hurt > 0 && <span className="lesson-hurt"> · 坑 {l.stats.hurt}</span>}
                      </span>
                      <LessonRatio stats={l.stats} />
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="lessons-note faint">经验只在命中触发条件时注入 prompt（每条 ≤ 600 token）；不会改门禁，也不会改 workflow。</p>
      </div>
      {current && (
        <TabPanel key={current.id}>
          <LessonDetail lesson={current} onChanged={(l) => setLocal((m) => ({ ...m, [l.id]: l }))} />
        </TabPanel>
      )}
    </div>
  )
}
