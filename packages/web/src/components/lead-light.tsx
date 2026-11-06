import type { LeadPresence } from '@taktflow/core'
import './lead-light.css'

export const LEAD_STATE_LABEL: Record<LeadPresence['state'], string> = { idle: '空闲', thinking: '思考中', working: '工作中', waiting: '等人' }

function since(ts: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000))
  if (!Number.isFinite(s)) return ''
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  return `${Math.floor(s / 3600)} 小时前`
}

/**
 * Lead 状态灯：working 随节拍脉动；waiting 琥珀慢闪；idle 暗呼吸；thinking 扫光。
 * 显示在成员栏与群头，悬停（或键盘聚焦）显示 presence.detail。showLabel 时在灯旁显示状态文字。
 * 颜色永远配文字（showLabel 时可见，否则读屏 + 悬停提示），不单靠颜色传达状态。
 */
export function LeadLight({ presence, showLabel = false }: { presence?: LeadPresence; showLabel?: boolean }) {
  if (!presence) return null
  const label = LEAD_STATE_LABEL[presence.state]
  const tip = `Lead ${label}${presence.detail ? `：${presence.detail}` : ''}${presence.since ? ` · ${since(presence.since)}` : ''}`
  return (
    <span className={showLabel ? 'lead-light with-label' : 'lead-light'} data-state={presence.state} title={showLabel ? undefined : tip} tabIndex={showLabel ? 0 : undefined} aria-label={showLabel ? tip : undefined}>
      <span className="lead-light-dot" aria-hidden="true" />
      {showLabel ? (
        <>
          {/* key 换了就重播一次短促淡入：状态切换看得见，但不跳 */}
          <span key={presence.state} className={presence.state === 'thinking' ? 'lead-light-label shimmer-text' : 'lead-light-label'} aria-hidden="true">
            {label}
          </span>
          {presence.detail && (
            <span className="lead-light-tip" role="tooltip" aria-hidden="true">
              <span className="lead-light-tip-state">{label}</span>
              {presence.detail}
            </span>
          )}
        </>
      ) : (
        <span className="sr-only">Lead {label}</span>
      )}
    </span>
  )
}
