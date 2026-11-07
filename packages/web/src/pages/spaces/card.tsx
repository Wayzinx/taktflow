import { useRef, useState, type CSSProperties } from 'react'
import { Archive, ArrowRight, Copy, MoreHorizontal, Pencil, Settings2 } from 'lucide-react'
import type { SpaceSummary } from '@taktflow/core'
import { SpaceMark } from '../../components/space-switcher'
import { CountUp, Menu } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { Link, navigate } from '../../lib/router'
import { spacePath } from '../../lib/space'
import { openCreateSpace } from '../../lib/ui-store'

/** 一张空间卡片：颜色方块、名称与 id、四个数字、最近活动；右上角菜单：编辑 / 复制为新空间 / 设置 / 归档。 */
export function SpaceCard({
  s,
  current,
  className,
  style,
  onEdit,
  onArchive,
}: {
  s: SpaceSummary
  current: boolean
  className?: string
  style?: CSSProperties
  onEdit: () => void
  onArchive: () => void
}) {
  const [menu, setMenu] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const stats: Array<{ label: string; v: number; tone?: 'running' | 'waiting' | 'failed' }> = [
    { label: '需求', v: s.requirements },
    { label: '进行中', v: s.active, tone: s.active ? 'running' : undefined },
    { label: '待办', v: s.pendingAttention ?? 0, tone: s.pendingAttention ? 'waiting' : undefined },
    { label: '风险', v: s.risks ?? 0, tone: s.risks ? 'failed' : undefined },
  ]
  return (
    <article className={`sp-card${current ? ' current' : ''}${className ? ` ${className}` : ''}`} style={{ ...style, ...(s.color ? ({ '--sp-color': s.color } as CSSProperties) : {}) }}>
      <header className="sp-card-head">
        <SpaceMark space={s} size={32} />
        <div className="sp-card-name">
          <Link to={spacePath(s.id)} className="sp-card-link truncate">
            {s.name}
          </Link>
          <span className="mono faint truncate">{s.id}</span>
        </div>
        {current && <span className="sp-current">当前</span>}
        <button ref={btn} type="button" className="btn btn-ghost btn-icon btn-sm sp-card-more" aria-label={`${s.name} 的更多操作`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((o) => !o)} title="更多操作">
          <MoreHorizontal />
        </button>
        <Menu
          open={menu}
          onClose={() => setMenu(false)}
          anchor={btn}
          placement="bottom-end"
          ariaLabel="空间操作"
          items={[
            { id: 'edit', label: '编辑名称、描述与颜色', icon: Pencil, onSelect: onEdit },
            { id: 'copy', label: '复制为新空间', icon: Copy, onSelect: () => openCreateSpace({ copyFrom: s.id }) },
            { id: 'settings', label: '空间设置', icon: Settings2, onSelect: () => navigate(spacePath(s.id, '/settings')) },
            {
              id: 'archive',
              label: '归档',
              icon: Archive,
              separator: true,
              danger: true,
              disabled: s.active > 0,
              hint: s.active > 0 ? `${s.active} 个进行中` : undefined,
              onSelect: onArchive,
            },
          ]}
        />
      </header>
      <p className={`sp-card-desc${s.description ? '' : ' faint'}`}>{s.description || '还没有描述'}</p>
      <dl className="sp-stats">
        {stats.map((x) => (
          <div key={x.label} className={`sp-stat${x.tone ? ` tone-${x.tone}` : ''}`}>
            <dt>{x.label}</dt>
            <dd className="num">
              <CountUp value={x.v} />
            </dd>
          </div>
        ))}
      </dl>
      <footer className="sp-card-foot">
        <span className="faint">{s.lastActivityAt ? `最近活动 ${fmtRelative(s.lastActivityAt)}` : '还没有活动'}</span>
        <span className="sp-enter" aria-hidden>
          进入
          <ArrowRight />
        </span>
      </footer>
    </article>
  )
}
