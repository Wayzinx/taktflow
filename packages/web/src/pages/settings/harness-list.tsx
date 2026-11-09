import { useState, type CSSProperties, type ReactNode } from 'react'
import { Check, ChevronRight, CircleAlert, CircleCheck, Minus, PowerOff } from 'lucide-react'
import type { HarnessInfo } from '@taktflow/core'
import { CAPABILITIES, HARNESS_SOURCE } from '../../lib/capabilities'
import { PROTOCOL_SHORT } from './runtime/shared'
import './harness-list.css'

/** "Claude Code" → CC，"Codex" → Co。 */
function monogram(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return name.slice(0, 1).toUpperCase() + name.slice(1, 2)
}

/** server 透传的是原始进程错误（"Process error: spawn gemini ENOENT\nProcess exited…"），换成人话，原文放 title。 */
export function readableReason(reason: string | undefined): string {
  if (!reason) return '可用性检查未通过'
  const missing = /spawn (\S+) ENOENT/.exec(reason)
  if (missing) return `未找到命令 ${missing[1]}：未安装或不在 PATH 中`
  return reason.split('\n')[0]!
}

/** 能接哪些模型 API：自定义 provider 时能直接说的协议；不支持就只用自带。 */
function ModelApis({ h }: { h: HarnessInfo }) {
  const protocols = h.capabilities.customProvider ? (h.capabilities.providerProtocols ?? []) : []
  if (!protocols.length) return <span className="faint">只用自带模型</span>
  return (
    <span className="hx-protos">
      {h.capabilities.requiresProvider ? null : <span className="hx-proto is-own">自带</span>}
      {protocols.map((p) => (
        <span key={p} className="hx-proto">
          {PROTOCOL_SHORT[p]}
        </span>
      ))}
    </span>
  )
}

function Status({ h }: { h: HarnessInfo }) {
  const disabled = Boolean(h.override?.disabled)
  return (
    <span className={`hx-status${disabled ? ' is-off' : h.available ? ' ok' : ''}`}>
      {disabled ? <PowerOff aria-hidden /> : h.available ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
      {disabled ? '已停用' : h.available ? '可用' : '不可用'}
    </span>
  )
}

/** 展开后：九项能力逐条写清楚支持与否、不支持时引擎怎么降级。 */
function Capabilities({ h }: { h: HarnessInfo }) {
  return (
    <ul className="hx-caps-detail">
      {CAPABILITIES.map((c) => {
        const on = Boolean(h.capabilities[c.key])
        const Icon = c.icon
        return (
          <li key={c.key} className={on ? 'on' : undefined}>
            <Icon aria-hidden className="hx-cap-icon" />
            <b>{c.label}</b>
            <span className="hx-cap-state">
              {on ? <Check aria-hidden /> : <Minus aria-hidden />}
              {on ? '支持' : '不支持'}
            </span>
            <span className="hx-cap-text">{on ? c.on : `降级：${c.off}`}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** 一行一个 harness；点名字展开能力详情。actions：右侧操作；below：测试结果。 */
export function HarnessRow({ h, actions, below }: { h: HarnessInfo; actions?: ReactNode; below?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const src = HARNESS_SOURCE[h.source]
  const supported = CAPABILITIES.filter((c) => h.capabilities[c.key]).length
  const disabled = Boolean(h.override?.disabled)
  const command = h.command?.join(' ')
  return (
    <li className={`hx-row${open ? ' open' : ''}${h.available ? '' : ' down'}${disabled ? ' is-disabled' : ''}`} style={{ '--src': src.color } as CSSProperties}>
      <div className="hx-main">
        <button type="button" className="hx-who" aria-expanded={open} onClick={() => setOpen((x) => !x)} title={open ? '收起能力详情' : '展开能力详情'}>
          <ChevronRight aria-hidden className="hx-caret" />
          <span className="hx-mono" aria-hidden>
            {monogram(h.displayName)}
          </span>
          <span className="hx-name">
            <span className="hx-title">
              <b className="truncate">{h.displayName}</b>
              <span className="hx-src" title={src.hint}>
                {src.label}
              </span>
            </span>
            {!h.available && !disabled ? (
              <span className="hx-sub hx-reason truncate" title={h.reason}>
                {readableReason(h.reason)}
              </span>
            ) : (
              <span className="hx-sub mono truncate" title={command ?? h.id}>
                {command ?? h.id}
                {(h.override?.command || h.override?.env) && <span className="hx-tag">已覆盖</span>}
              </span>
            )}
          </span>
        </button>
        <span className="hx-apis">
          <ModelApis h={h} />
        </span>
        <span className="hx-caps" title="点名字展开看每一项">
          <span className="num">
            {supported}/{CAPABILITIES.length}
          </span>
          <span className="hx-meter" aria-hidden>
            <span style={{ transform: `scaleX(${supported / CAPABILITIES.length})` }} />
          </span>
        </span>
        <span className="hx-roles">
          {h.roles.length ? (
            <>
              {h.roles.slice(0, 3).map((r) => (
                <span key={r} className="chip mono">
                  {r}
                </span>
              ))}
              {h.roles.length > 3 && (
                <span className="chip hx-more" title={h.roles.join('、')}>
                  +{h.roles.length - 3}
                </span>
              )}
            </>
          ) : (
            <span className="faint">—</span>
          )}
        </span>
        <Status h={h} />
        <span className="hx-acts">{actions}</span>
      </div>
      {open && <Capabilities h={h} />}
      {below}
    </li>
  )
}

/** 列头：和行用同一套网格列。 */
export function HarnessListHead() {
  return (
    <div className="hx-head" aria-hidden>
      <span>Harness</span>
      <span>能接的模型 API</span>
      <span>能力</span>
      <span>默认角色</span>
      <span>状态</span>
      <span />
    </div>
  )
}

/** 不可用的一组折起来：没装的 agent 一排卡片只是噪音，需要时再展开。 */
export function DownGroup({ count, names, open, onToggle, children }: { count: number; names: string[]; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <li className={`hx-group${open ? ' open' : ''}`}>
      <button type="button" className="hx-group-head" aria-expanded={open} onClick={onToggle}>
        <ChevronRight aria-hidden className="hx-caret" />
        <b>{count} 个不可用</b>
        <span className="faint truncate">{names.join(' · ')}</span>
        <span className="hx-group-hint faint">未安装、没登录或已停用</span>
      </button>
      {open && <ul className="hx-sublist">{children}</ul>}
    </li>
  )
}
