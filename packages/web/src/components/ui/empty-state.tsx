import type { ReactNode } from 'react'
import { RotateCw, type LucideIcon } from 'lucide-react'
import type { StewardContextRef } from '@taktflow/core'
import { askSteward } from '../../lib/ui-store'
import { BeeGlyph } from '../identity'
import { Bee, type BeeState } from '../mascot'
import './primitives.css'

export interface EmptyStateProps {
  /** @deprecated 空态统一画睡着的节拍蜂（docs/design/30 §1），不再画图标；留着只为不改调用方。 */
  icon?: LucideIcon
  title: string
  /** 一句话：为什么是空的、下一步做什么。不教用户改文件或跑 CLI（ux:audit 会警告）。 */
  body?: ReactNode
  /** @deprecated 旧名，等同 body。 */
  hint?: ReactNode
  /** 一个主动作（.btn-primary）。 */
  action?: ReactNode
  /** "让管家帮我"：点击打开停靠面板并预填这句话。 */
  stewardAsk?: string
  stewardContext?: StewardContextRef[]
  /** 卡片 / 面板里的小号空态：48px 蜂、更紧的间距。 */
  compact?: boolean
  /** 蜂的状态，默认睡着（点它会醒）。 */
  mascot?: BeeState
  className?: string
}

/**
 * 空状态（体验基线 2、docs/design/30 §1）：节拍蜂 + 一句话 + 一个主动作 + 可选"让管家帮我"。全站只有这一种空态，页面里不要自己拼。
 *   <EmptyState title="还没有知识库" body="知识库让节点查到业务规则和接口。" action={<button className="btn btn-primary">新建知识库</button>} stewardAsk="帮我从 docs/ 建一个文档知识库" />
 */
export function EmptyState({ title, body, hint, action, stewardAsk, stewardContext, compact, mascot = 'sleep', className }: EmptyStateProps) {
  const text = body ?? hint
  return (
    <div className={`empty-state${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      <Bee className="empty-bee" state={mascot} size={compact ? 48 : 76} calm={compact} interactive />
      <div className="empty-title">{title}</div>
      {text && <div className="empty-hint">{text}</div>}
      {(action || stewardAsk) && (
        <div className="empty-action">
          {action}
          {stewardAsk && (
            <button type="button" className="btn btn-ghost btn-sm empty-ask" onClick={() => askSteward(stewardAsk, stewardContext)}>
              <BeeGlyph aria-hidden />
              让管家帮我
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 从错误里读出 HTTP 状态（ApiRequestError.status），没有时为 undefined。 */
function statusOf(error: unknown): number | undefined {
  const s = (error as { status?: unknown } | undefined)?.status
  return typeof s === 'number' ? s : undefined
}

export interface ErrorStateProps {
  error: Error
  onRetry?: () => void
  /** 默认"加载失败"。 */
  title?: string
  /** 权限问题时告诉用户去找谁（例如空间 owner 的名字）。 */
  contact?: string
  compact?: boolean
}

/**
 * 错误状态（体验基线 2）：说明原因 + 重试；403 时说明去找谁；网络不可达单独提示。
 *   if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
 */
export function ErrorState({ error, onRetry, title, contact, compact }: ErrorStateProps) {
  const status = statusOf(error)
  const forbidden = status === 401 || status === 403
  const offline = !status && /fetch|network|Failed to fetch/i.test(error.message)
  const head = title ?? (forbidden ? '没有权限查看' : offline ? '连不上服务' : '加载失败')
  const why = forbidden ? `需要更高的空间角色${contact ? `，请联系 ${contact}` : '，请联系空间 owner'}。` : offline ? '检查网络或服务是否在运行，然后重试。' : undefined
  return (
    <div className={`empty-state error-state${compact ? ' compact' : ''}`} role="alert">
      <Bee className="empty-bee" state={forbidden || offline ? 'ask' : 'failed'} size={compact ? 48 : 76} calm={compact} interactive />
      <div className="empty-title">{head}</div>
      <div className="empty-hint">
        {why && <div>{why}</div>}
        <span className="mono error-detail">{error.message}</span>
      </div>
      {onRetry && (
        <div className="empty-action">
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            <RotateCw aria-hidden />
            重试
          </button>
        </div>
      )}
    </div>
  )
}
