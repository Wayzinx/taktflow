import { BookOpen, Boxes, FlaskConical, Inbox, LayoutDashboard, LayoutGrid, ListTodo, Settings, Shapes, UserRoundCog, Workflow, Zap, type LucideIcon } from 'lucide-react'
import { BeeGlyph } from '../bee-glyph'

export interface PageEntry {
  to: string
  label: string
  icon: LucideIcon
  /** 搜索词：英文、拼音、近义词。 */
  keywords: string
  /** 开发用的页面（组件陈列）：只在开发构建或 ?dev=1 时出现在 ⌘K 里。 */
  dev?: boolean
}

/** ⌘K 的“页面”分组；侧栏的每个导航项都要在这里（pages.test.ts 检查）。 */
export const PAGES: PageEntry[] = [
  { to: '/', label: '总览', icon: LayoutDashboard, keywords: 'overview home zonglan' },
  { to: '/requirements', label: '需求列表', icon: ListTodo, keywords: 'requirements xuqiu' },
  { to: '/attention', label: '待办', icon: Inbox, keywords: 'attention todo daiban' },
  { to: '/knowledge', label: '知识库', icon: BookOpen, keywords: 'knowledge zhishi kb rag wiki' },
  { to: '/solo', label: '管家 · 整页对话', icon: BeeGlyph, keywords: 'solo steward guanjia assistant agent 管家 对话' },
  { to: '/spaces', label: '全部空间', icon: Boxes, keywords: 'spaces kongjian' },
  { to: '/workflows', label: '流水线', icon: Workflow, keywords: 'workflows workflow pipeline liushuixian bianji' },
  { to: '/eval', label: '评测', icon: FlaskConical, keywords: 'eval evaluation pingce scorecard 成绩单 回放 基线' },
  { to: '/automations', label: '自动化', icon: Zap, keywords: 'automations schedule cron im feishu slack webhook zidonghua 定时 通知 飞书 汇报' },
  { to: '/settings', label: '空间设置', icon: Settings, keywords: 'settings space members repos models harness shezhi' },
  { to: '/settings?tab=lessons', label: '经验库', icon: BookOpen, keywords: 'lessons jingyan 经验' },
  { to: '/settings?tab=agents', label: '角色', icon: UserRoundCog, keywords: 'roles agents harness model skills juese 角色 技能' },
  { to: '/settings?tab=shared', label: '共享资源', icon: LayoutGrid, keywords: 'shared resources skills knowledge repos gongxiang 共享 资源' },
  { to: '/ui', label: '组件陈列', icon: Shapes, keywords: 'ui components gallery design system zujian 组件 规范 头像 图标', dev: true },
]

/** 编辑距离（只用于很短的路径段）。 */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]!
}

/**
 * 地址打错时猜用户要去的页面（404 页“你是不是要找…”）：比较第一段路径，编辑距离不超过 2（长词 3）才算像，猜不到返回 undefined。
 */
export function suggestPage(path: string): PageEntry | undefined {
  const seg = path.split('/').filter(Boolean)[0]?.toLowerCase()
  if (!seg) return undefined
  let best: { page: PageEntry; d: number } | undefined
  for (const page of PAGES) {
    const target = page.to.split(/[/?]/).filter(Boolean)[0]
    if (!target || page.dev || page.to.includes('?')) continue
    const d = distance(seg, target)
    if (d <= (target.length > 6 ? 3 : 2) && (!best || d < best.d)) best = { page, d }
  }
  return best?.page
}
