import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import type { StewardContextRef } from '@taktflow/core'
import { currentSpaceId } from '../../lib/space'
import { useAsync } from '../../api'
import { askSteward } from '../../lib/ui-store'
import './primitives.css'

export interface PageHeaderProps {
  title: ReactNode
  /** 一句话说明这页是干什么的 / 现在怎么样。 */
  description?: ReactNode
  /** @deprecated 旧名，等同 description。 */
  sub?: ReactNode
  /** 主动作放右侧；主按钮用 .btn-primary，最多一个。 */
  actions?: ReactNode
  /** 管家建议：最多显示 3 个小胶囊，点击打开停靠面板并预填问题。 */
  suggestions?: string[]
  /** 点建议时一并带给管家的上下文（不给则由面板按当前页推导）。 */
  suggestionContext?: StewardContextRef[]
  /** 自定义点建议的行为（管家整页：开新会话并预填，而不是打开停靠面板）。 */
  onSuggestion?: (text: string) => void
  /** 标题左侧的图标或标识。 */
  icon?: ReactNode
  /** 标题上方的小字（所属空间、类型）。 */
  eyebrow?: ReactNode
  /** 共享元素过渡名（vtName('req', id)）：列表 → 详情的标题过渡。 */
  titleTransitionName?: string
}

/**
 * 统一页头（体验基线 1）：标题 + 一句说明 + 右侧主动作 + 说明下方的管家建议胶囊。
 *   <PageHeader title="需求" description="7 个需求，4 个进行中" actions={<NewRequirementButton />} suggestions={useStewardSuggestions('requirements')} />
 */
export function PageHeader({ title, description, sub, actions, suggestions, suggestionContext, onSuggestion, icon, eyebrow, titleTransitionName }: PageHeaderProps) {
  const desc = description ?? sub
  const chips = (suggestions ?? []).slice(0, 3)
  return (
    <header className="page-header">
      {icon && <span className="page-header-icon">{icon}</span>}
      <div className="page-header-main">
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title" style={titleTransitionName ? { viewTransitionName: titleTransitionName } : undefined}>
          {title}
        </h1>
        {desc && <div className="page-sub">{desc}</div>}
        {chips.length > 0 && <SuggestionChips items={chips} context={suggestionContext} onPick={onSuggestion} />}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

/** 管家建议胶囊（页头、空状态、卡片底部都可以用）。 */
export function SuggestionChips({ items, context, className, onPick }: { items: string[]; context?: StewardContextRef[]; className?: string; onPick?: (text: string) => void }) {
  return (
    <div className={`suggest-row${className ? ` ${className}` : ''}`} aria-label="让管家帮忙">
      {items.slice(0, 3).map((s) => (
        <button key={s} type="button" className="suggest-chip pressable" onClick={() => (onPick ? onPick(s) : askSteward(s, context))} title={onPick ? '用这个问题开新会话' : '打开管家并预填这个问题'}>
          <Sparkles aria-hidden />
          <span className="truncate">{s}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * 当前页的管家建议（GET /api/steward/suggestions?page=&space=&id=，最多 3 条）。拿不到时返回空数组，不影响页面。
 * page 取值（与 core/steward/suggestions.ts 对齐）：overview / requirements / requirement / run / attention / workflows / workflow / knowledge（详情页带 id）/ settings-<tab> / eval / spaces / steward
 */
export function useStewardSuggestions(page: string, id?: string): string[] {
  // 默认空间 / 单空间模式下 URL 不带 /s/:space：用当前空间的真实 id，否则服务端只能说"当前空间"
  const q = useAsync(
    (ds) =>
      (page === 'spaces' || currentSpaceId() ? Promise.resolve(undefined) : ds.space().then((s) => s.id).catch(() => undefined))
        .then((space) => ds.stewardSuggestions({ page, id, ...(space ? { space } : {}) }))
        .catch(() => [] as string[]),
    [page, id],
  )
  return q.data ?? []
}
