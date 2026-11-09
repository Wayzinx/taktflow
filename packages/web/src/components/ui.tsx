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

/** 人的头像色：图表色板去掉灰（灰留给"未知 harness"），按 id 稳定取。 */
const AVATAR_COLORS = [1, 2, 3, 4, 5, 6, 8]
/** 头像只有四档（docs/design/30 §1）：16 行内、20 列表、24 卡片、32 详情；别的尺寸就近取。 */
const AVATAR_SIZES = [16, 20, 24, 32] as const
export const avatarColor = (key: string) => `var(--c-${AVATAR_COLORS[[...key].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length]})`

/** 头像里的字：16px 一个字母；汉字名 24px 以下只放最后一个字（两个字挤不进圆里）。 */
function avatarText(name: string, px: number): string {
  const t = initials(name)
  if (px <= 16) return /[一-龥]/.test(t) ? t.slice(-1) : t.slice(0, 1)
  return /[一-龥]/.test(t) && px < 24 ? t.slice(-1) : t
}

/** 人：首字母实色圆。id 定颜色（改名不变色），name 出字。agent 不用它，用 AgentMark。 */
export function Avatar({ name, id, size = 20, className }: { name: string; id?: string; size?: number; className?: string }) {
  const px = AVATAR_SIZES.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a))
  return (
    <span className={`avatar s${px}${className ? ` ${className}` : ''}`} title={name} role="img" aria-label={name} style={{ '--av': avatarColor(id ?? name) } as CSSProperties}>
      {avatarText(name, px)}
    </span>
  )
}

export function AvatarStack({ names, max = 4, size = 20 }: { names: string[]; max?: number; size?: number }) {
  return (
    <span className="avatar-stack">
      {names.slice(0, max).map((n) => (
        <Avatar key={n} name={n} size={size} />
      ))}
      {names.length > max && <span className={`avatar more s${size}`}>+{names.length - max}</span>}
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
export { HoverCard, useHoverCard } from './ui/hover-card'
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
