import type { CSSProperties } from 'react'
import type { Lesson } from '@taktflow/core'
import { VERDICT } from '../../lib/status'

/** 触发条件的紧凑标签：角色 / 路径 / 错误签名 / 判决类别。max 限制显示个数，其余折成 +n。 */
export function TriggerChips({ trigger, max = 4 }: { trigger: Lesson['trigger']; max?: number }) {
  const items: Array<{ key: string; text: string; mono: boolean; title: string }> = [
    ...(trigger.roles ?? []).map((r) => ({ key: `r:${r}`, text: `@${r}`, mono: true, title: `角色 ${r}` })),
    ...(trigger.paths ?? []).map((p) => ({ key: `p:${p}`, text: p, mono: true, title: `路径命中 ${p}` })),
    ...(trigger.signatures ?? []).map((s) => ({ key: `s:${s}`, text: `/${s}/`, mono: true, title: `错误签名 ${s}` })),
    ...(trigger.categories ?? []).map((c) => ({ key: `c:${c}`, text: VERDICT[c]?.label ?? c, mono: false, title: `判决类别 ${c}` })),
  ]
  if (items.length === 0) return <span className="faint">任何节点</span>
  const shown = items.slice(0, max)
  return (
    <span className="lesson-chips">
      {shown.map((i) => (
        <span key={i.key} className={`chip chip-sm${i.mono ? ' mono' : ''}`} title={i.title}>
          {i.text}
        </span>
      ))}
      {items.length > shown.length && <span className="faint num">+{items.length - shown.length}</span>}
    </span>
  )
}

/** 召回效果条：帮助（左起，成功色）与坑（右起，失败色）各占召回次数的比例；静态，不做动画。 */
export function LessonRatio({ stats }: { stats: Lesson['stats'] }) {
  const total = Math.max(stats.recalled, 1)
  const style = { '--helped': stats.helped / total, '--hurt': stats.hurt / total } as CSSProperties
  return (
    <span className="lesson-ratio" style={style} aria-hidden>
      <span className="lesson-ratio-helped" />
      <span className="lesson-ratio-hurt" />
    </span>
  )
}

export function LessonStats({ stats }: { stats: Lesson['stats'] }) {
  return (
    <span className="lesson-stats">
      <span title="被召回注入的次数">
        召回 <b className="num">{stats.recalled}</b>
      </span>
      <span title="召回后本节点一次通过">
        帮助 <b className="num">{stats.helped}</b>
      </span>
      <span title="召回后反而失败或被打回" className={stats.hurt > 0 ? 'is-hurt' : undefined}>
        坑 <b className="num">{stats.hurt}</b>
      </span>
    </span>
  )
}
