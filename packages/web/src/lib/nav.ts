import { BookOpen, FlaskConical, Inbox, LayoutDashboard, ListTodo, Settings, Workflow, Zap, type LucideIcon } from 'lucide-react'

/** 空间侧栏的导航项（components/layout 渲染）。⌘K 的“页面”分组必须一一覆盖（command-palette/pages.test.ts）。 */
export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** 悬停时图标的小动作（layout.css 的 data-motion）。 */
  motion: string
  /** 当前路径（去掉空间前缀）是否属于这一项。 */
  active: (path: string) => boolean
}

/** path 是 base 本身或它下面的页面（/settingss 这种打错的地址不算）。 */
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

export const SPACE_NAV: NavItem[] = [
  { to: '/', label: '总览', icon: LayoutDashboard, motion: 'tiles', active: (p) => p === '/' },
  { to: '/requirements', label: '需求', icon: ListTodo, motion: 'drop', active: (p) => under(p, '/requirements') || under(p, '/req') || under(p, '/run') },
  { to: '/attention', label: '待办', icon: Inbox, motion: 'pop', active: (p) => p === '/attention' },
  { to: '/knowledge', label: '知识库', icon: BookOpen, motion: 'open', active: (p) => under(p, '/knowledge') },
  { to: '/workflows', label: '流水线', icon: Workflow, motion: 'shift', active: (p) => under(p, '/workflows') },
  { to: '/eval', label: '评测', icon: FlaskConical, motion: 'swing', active: (p) => p === '/eval' },
  { to: '/automations', label: '自动化', icon: Zap, motion: 'jolt', active: (p) => p === '/automations' },
  { to: '/settings', label: '空间设置', icon: Settings, motion: 'turn', active: (p) => under(p, '/settings') },
]
