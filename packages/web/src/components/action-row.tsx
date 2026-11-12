import type { ReactNode } from 'react'
import { BookOpen, ChartNoAxesColumn, ChevronRight, Eye, FilePen, FileText, Globe, ScanSearch, Search, Send, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react'
import type { Action, ActionKind } from '../lib/actions'
import './action-row.css'

const KIND_ICON: Record<ActionKind, LucideIcon> = {
  read: FileText,
  search: Search,
  edit: FilePen,
  command: SquareTerminal,
  web: Globe,
  knowledge: BookOpen,
  delegate: Send,
  other: Wrench,
}
/** 管家的动词有自己的图标（查看是眼睛、绘制是图表），其余按类别。 */
const VERB_ICON: Record<string, LucideIcon> = { 查看: Eye, 核对: ScanSearch, 绘制: ChartNoAxesColumn }
export const actionIcon = (a: Action): LucideIcon => VERB_ICON[a.verb] ?? KIND_ICON[a.kind]

/** 路径 / 命令 / 查询用等宽；"需求列表""REQ-002 的状态"这类说明用正文字体。 */
const MONO: ReadonlySet<ActionKind> = new Set(['read', 'search', 'edit', 'command'])
const isCode = (a: Action) => MONO.has(a.kind) && /[./_-]/.test(a.target) && !/[一-鿿]/.test(a.target)

/** 一句动作："读取 …/export/csv.ts ×3 · +12 −3"。动词加粗，对象可截断，结果词着色。 */
export function ActionText({ action: a, count = 1 }: { action: Action; count?: number }) {
  const tone = a.ok === false ? 'failed' : a.result === '通过' || a.result === '全部通过' ? 'success' : undefined
  return (
    <span className="act-text" title={a.full}>
      <span className="act-verb">{a.verb}</span>
      <span className={`act-target truncate${isCode(a) ? ' mono' : ''}`}>{a.target}</span>
      {count > 1 && <span className="act-n num">×{count}</span>}
      {(a.add !== undefined || a.del !== undefined) && (
        <span className="act-diff num" aria-label={`新增 ${a.add ?? 0} 行，删除 ${a.del ?? 0} 行`}>
          {a.add ? <span data-t="add">+{a.add}</span> : null}
          {a.del ? <span data-t="del">−{a.del}</span> : null}
        </span>
      )}
      {a.result && (
        <span className="act-result" data-tone={tone}>
          {a.result}
        </span>
      )}
    </span>
  )
}

const fmtMs = (ms?: number) => (ms === undefined ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s` : `${ms}ms`)

/**
 * 动作清单里的一行：图标（运行中带节拍光环）· 动作 · 耗时 · 展开箭头。
 * 有 children 时可点开看原始输入 / 输出（grid-template-rows 展开，不量高度）。
 */
export function ActionRow({ action, count, state, ms, open, onToggle, animate, children }: { action: Action; count?: number; state: 'running' | 'done' | 'failed' | 'stopped'; ms?: number; open?: boolean; onToggle?: () => void; animate?: boolean; children?: ReactNode }) {
  const Icon = actionIcon(action)
  const expandable = !!children && state !== 'running'
  return (
    <li className={`act-row${animate ? ' act-in' : ''}`} data-state={state}>
      <button type="button" className="act-head pressable" aria-expanded={expandable ? !!open : undefined} onClick={expandable ? onToggle : undefined} disabled={!expandable}>
        <span className={`act-icon${state === 'running' ? ' live-ring' : ''}`} aria-hidden>
          <Icon />
        </span>
        <span className={state === 'running' ? 'act-live shimmer-text' : 'act-live'}>
          <ActionText action={action} count={count} />
        </span>
        {state === 'stopped' ? <span className="act-ms">没做完</span> : state !== 'running' && ms !== undefined && <span className="act-ms num">{fmtMs(ms)}</span>}
        {expandable && <ChevronRight className="act-chev" aria-hidden />}
      </button>
      {expandable && (
        <div className="expand" data-open={!!open}>
          <div>
            <div className="act-body">{children}</div>
          </div>
        </div>
      )}
    </li>
  )
}
