import { useState, type CSSProperties, type ReactNode } from 'react'
import { Check, CircleAlert, CircleCheck, Minus, PowerOff, TerminalSquare } from 'lucide-react'
import type { HarnessInfo } from '@taktflow/core'
import { CAPABILITIES, HARNESS_SOURCE, type CapabilityMeta } from '../../lib/capabilities'

/** "Claude Code" → CC，"Codex" → Co。 */
function monogram(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return name.slice(0, 1).toUpperCase() + name.slice(1, 2)
}

/** server 透传的是原始进程错误（"Process error: spawn gemini ENOENT\nProcess exited…"），卡片上换成人话，原文放 title。 */
function readableReason(reason: string | undefined): string {
  if (!reason) return '可用性检查未通过'
  const missing = /spawn (\S+) ENOENT/.exec(reason)
  if (missing) return `未找到命令 ${missing[1]}：未安装或不在 PATH 中`
  return reason.split('\n')[0]!
}

function CapTile({ cap, on, align }: { cap: CapabilityMeta; on: boolean; align: 'start' | 'center' | 'end' }) {
  const Icon = cap.icon
  // tooltip 只在悬停 / 聚焦时挂载：54 个隐藏浮层常驻 DOM 会让读屏和检测都把它们当正文
  const [open, setOpen] = useState(false)
  const show = () => setOpen(true)
  const hide = () => setOpen(false)
  return (
    <span
      className={`cap${on ? ' on' : ''}`}
      tabIndex={0}
      aria-label={`${cap.label}：${on ? '支持' : '不支持'}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <Icon strokeWidth={2} />
      {!on && <span className="cap-slash" aria-hidden />}
      {open && (
        <span className={`cap-tip align-${align}`} role="tooltip">
          <span className="cap-tip-head">
            <b>{cap.label}</b>
            <span className={`cap-tip-state${on ? ' on' : ''}`}>
              {on ? <Check /> : <Minus />}
              {on ? '支持' : '不支持'}
            </span>
          </span>
          <span className="cap-tip-body">{on ? cap.on : `降级：${cap.off}`}</span>
        </span>
      )}
    </span>
  )
}

/** actions：页脚右侧的操作（测试 / 设置…）；below：卡片底部的测试结果。 */
export function HarnessCard({ h, actions, below }: { h: HarnessInfo; actions?: ReactNode; below?: ReactNode }) {
  const src = HARNESS_SOURCE[h.source]
  const supported = CAPABILITIES.filter((c) => h.capabilities[c.key]).length
  const disabled = Boolean(h.override?.disabled)
  return (
    <article
      className={`card harness-card${h.available ? '' : ' unavailable'}${disabled ? ' is-disabled' : ''}`}
      style={{ '--src': src.color } as CSSProperties}
    >
      <header className="hc-head">
        <span className="hc-mono" aria-hidden>
          {monogram(h.displayName)}
        </span>
        <div className="hc-name">
          <div className="hc-title truncate">{h.displayName}</div>
          <div className="hc-sub">
            <span className="mono truncate">{h.id}</span>
            <span className="hc-src" title={src.hint}>
              {src.label}
            </span>
          </div>
        </div>
        <span className={`hc-avail${h.available ? ' ok' : ''}`}>
          {disabled ? <PowerOff strokeWidth={2.2} /> : h.available ? <CircleCheck strokeWidth={2.2} /> : <CircleAlert strokeWidth={2.2} />}
          {disabled ? '已停用' : h.available ? '可用' : '不可用'}
        </span>
      </header>
      {h.command && (
        <div className="hc-cmd" title={h.command.join(' ')}>
          <TerminalSquare aria-hidden />
          <span className="mono truncate">{h.command.join(' ')}</span>
          {(h.override?.command || h.override?.env) && <span className="hc-cmd-tag">已覆盖</span>}
        </div>
      )}
      {!h.available && !disabled && (
        <div className="hc-reason" title={h.reason}>
          <CircleAlert />
          <span>{readableReason(h.reason)}</span>
        </div>
      )}
      <div className="hc-caps">
        <div className="hc-label">
          能力
          <span className="num">
            {supported}/{CAPABILITIES.length}
          </span>
          <span className="hc-caps-meter" aria-hidden>
            <span style={{ width: `${(supported / CAPABILITIES.length) * 100}%` }} />
          </span>
        </div>
        <div className="cap-row">
          {CAPABILITIES.map((c, i) => (
            <CapTile
              key={c.key}
              cap={c}
              on={Boolean(h.capabilities[c.key])}
              align={i < 2 ? 'start' : i > CAPABILITIES.length - 3 ? 'end' : 'center'}
            />
          ))}
        </div>
      </div>
      <footer className="hc-roles">
        <span className="hc-label">默认角色</span>
        {h.roles.length ? (
          <span className="hc-role-list">
            {h.roles.map((r) => (
              <span key={r} className="chip mono">
                {r}
              </span>
            ))}
          </span>
        ) : (
          <span className="faint">未绑定 · 节点或角色里指定 harness 时使用</span>
        )}
        {actions && <span className="hc-acts">{actions}</span>}
      </footer>
      {below}
    </article>
  )
}
