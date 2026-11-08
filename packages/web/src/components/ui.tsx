import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { NodeKind } from '@taktflow/core'
import { NODE_KIND, toneSoftVar, toneVar, type StatusMeta, type Tone } from '../lib/status'
import { initials } from '../lib/format'
import './ui.css'

export function StatusBadge({ meta, subtle }: { meta: StatusMeta; subtle?: boolean }) {
  const Icon = meta.icon
  return (
    <span className={`status-badge${subtle ? ' subtle' : ''}`} style={{ '--tone': meta.tone === 'pending' ? 'var(--text-2)' : toneVar(meta.tone), '--tone-soft': toneSoftVar(meta.tone) } as CSSProperties}>
      <Icon className={meta.spin ? 'spin' : undefined} strokeWidth={2.4} />
      {meta.label}
    </span>
  )
}

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={`status-dot${pulse ? ' pulse' : ''}`} style={{ '--tone': toneVar(tone) } as CSSProperties} />
}

export function KindIcon({ kind, size = 22 }: { kind: NodeKind; size?: number }) {
  const { icon: Icon, label } = NODE_KIND[kind]
  return (
    <span className={`kind-icon kind-${kind}`} style={{ width: size, height: size }} title={label}>
      <Icon strokeWidth={2} />
    </span>
  )
}

const AVATAR_HUES = [248, 190, 152, 32, 330, 270, 210]
export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const hue = AVATAR_HUES[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % AVATAR_HUES.length]
  // 小于 20px 放不下 11px 的字，只留色块，名字在 title / aria-label 里
  const tiny = size < 20
  return (
    <span className="avatar" title={name} aria-label={name} style={{ width: size, height: size, fontSize: tiny ? undefined : Math.max(11, size * 0.42), '--hue': hue } as CSSProperties}>
      {tiny ? null : initials(name)}
    </span>
  )
}

export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  return (
    <span className="avatar-stack">
      {names.slice(0, max).map((n) => (
        <Avatar key={n} name={n} />
      ))}
      {names.length > max && <span className="avatar more">+{names.length - max}</span>}
    </span>
  )
}

export interface TabDef {
  id: string
  label: string
  icon?: LucideIcon
  count?: number
  hidden?: boolean
}

/**
 * Tab 条：一个指示器按 transform 平移 / 缩放到当前 Tab（150ms）；内容用 <TabPanel key={tab}> 交叉淡化。
 *   <Tabs tabs={…} value={tab} onChange={setTab} />  <TabPanel key={tab}>…</TabPanel>
 */
/** 最近一次点 Tab 的方向（往右 1 / 往左 -1）与时刻：随后挂载的 TabPanel 从那一侧滑入；不是点 Tab 引起的切换（链接、前进后退）只淡入。 */
let tabMove = { dir: 0, at: 0 }

export function Tabs({ tabs, value, onChange, size }: { tabs: TabDef[]; value: string; onChange: (id: string) => void; size?: 'sm' }) {
  const root = useRef<HTMLDivElement>(null)
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>('.tab.active')
    if (!el) return setInd(null)
    // 与原来的 ::after 一致：左右各内缩 10px
    const next = { x: el.offsetLeft + 10, w: Math.max(0, el.offsetWidth - 20) }
    setInd((t) => (t && t.x === next.x && t.w === next.w ? t : next))
  })
  return (
    <div ref={root} className={`tabs${size === 'sm' ? ' tabs-sm' : ''}${ind ? ' has-indicator' : ''}`} role="tablist">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === value}
              className={`tab${t.id === value ? ' active' : ''}`}
              onClick={() => {
                const ids = tabs.filter((x) => !x.hidden).map((x) => x.id)
                tabMove = { dir: Math.sign(ids.indexOf(t.id) - ids.indexOf(value)), at: performance.now() }
                onChange(t.id)
              }}
            >
              {Icon && <Icon />}
              {t.label}
              {t.count !== undefined && <span className="tab-count num">{t.count}</span>}
            </button>
          )
        })}
      {ind && <span className="tabs-indicator" aria-hidden style={{ '--tab-x': `${ind.x}px`, '--tab-s': ind.w } as CSSProperties} />}
    </div>
  )
}

/**
 * Tab 内容：换 key 时淡入（交叉淡化的"入"半段；旧内容立即卸载，避免两份布局叠加跳动）。
 * 刚点过 Tab 时顺着方向滑入 10px：往右点从右边进、往左点从左边进。
 */
export function TabPanel({ children, className }: { children: ReactNode; className?: string }) {
  const [dir] = useState(() => (performance.now() - tabMove.at < 400 ? tabMove.dir : 0))
  return (
    <div role="tabpanel" className={`tab-panel${dir > 0 ? ' from-right' : dir < 0 ? ' from-left' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}

/** 进度条：--meter 驱动 transform: scaleX()（styles/motion.css .meter），不动画 width。 */
export function Meter({ value, tone = 'success', height = 6 }: { value: number; tone?: Tone; height?: number }) {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  return (
    <span className="meter meter-inline" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(v.toFixed(2))} style={{ height, '--meter': v, '--meter-color': toneVar(tone) } as CSSProperties}>
      <span className="meter-fill" />
    </span>
  )
}

// ---------------------------------------------------------------- 弹层原语（components/ui/）

export { Dialog, trapKeys, useRestoreFocus, type DialogProps } from './ui/dialog'
export { Popover, type Placement, type PopoverProps } from './ui/popover'
export { Menu, type MenuItem } from './ui/menu'

// ---------------------------------------------------------------- M4 原语（docs/dev/m4-web.md；用法见 packages/web/OWNERSHIP.md）

export { PageHeader, SuggestionChips, useStewardSuggestions, type PageHeaderProps } from './ui/page-header'
export { Skeleton, SkeletonCard, SkeletonGrid, SkeletonRows, SkeletonText } from './ui/skeleton'
export { EmptyState, ErrorState, type EmptyStateProps, type ErrorStateProps } from './ui/empty-state'
export { Toaster, dismissToast, toast, type ToastOptions } from './ui/toast'
export { CountUp } from './ui/count-up'
export { useStagger, type StaggerProps } from './ui/stagger'
export { useFlashOnChange, useFlashRows } from './ui/flash-row'
export { Segmented, type SegmentedOption } from './ui/segmented'
export { GlideMark, useGlide } from './ui/glide'
export { Chip, Chips, type ChipItem } from './ui/chips'
export { Kbd, withShortcut } from './ui/kbd'
export { Drawer, type DrawerProps } from './ui/drawer'
export { PageTransition, vtName } from './ui/page-transition'
export { ReasonDialog, ReasonField, RiskTag, RISK, reasonOk, type Risk } from './ui/reason-dialog'
