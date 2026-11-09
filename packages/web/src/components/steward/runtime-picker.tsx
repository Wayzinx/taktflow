import { useRef, useState, type CSSProperties } from 'react'
import { ChevronDown } from 'lucide-react'
import type { StewardRuntime, StewardRuntimeChoice } from '@taktflow/core'
import { useAsync } from '../../api'
import { harnessHue } from '../agent-mark'
import { Menu, type MenuItem } from '../ui'
import { pairingText } from '../../lib/pairing'

const same = (c: StewardRuntimeChoice, r?: StewardRuntime | null) => !!r && c.harness === (r.harness ?? 'native') && c.model === r.model
const modelName = (c: StewardRuntimeChoice) => (c.model ? c.modelLabel ?? c.model : '自带模型')
/** 按钮上的短名：内置只写模型；外部 harness 写 harness · 模型（自带模型只写 harness）。 */
export function runtimeLabel(c: StewardRuntimeChoice): string {
  if (c.harness === 'native') return modelName(c)
  return c.model ? `${c.harnessLabel} · ${modelName(c)}` : c.harnessLabel
}

/**
 * 管家用哪个 harness × 模型（docs/design/30 §2）：输入框左下角的选择器。
 * 只列服务端给的组合；不可用的置灰并写原因，经协议桥的标出「桥接 · Responses ← Chat」。value 为空表示跟随默认（偏好 > 空间配置）。
 * 服务端不支持（老版本 404）时不渲染。
 */
export function RuntimePicker({ value, onChange }: { value?: StewardRuntime | null; onChange: (next: StewardRuntime | null) => void }) {
  const q = useAsync((d) => d.stewardRuntimeChoices(), [])
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (q.error || (q.data && q.data.length === 0)) return null
  const choices = q.data ?? []
  const def = choices.find((c) => c.isDefault)
  const current = value ? choices.find((c) => same(c, value)) : def
  const text = current ? runtimeLabel(current) : value ? [value.harness ?? 'native', value.model].filter(Boolean).join(' · ') : '默认模型'

  const items: MenuItem[] = [
    { id: 'default', label: '跟随默认', hint: def ? runtimeLabel(def) : '按偏好设置', checked: !value, onSelect: () => onChange(null) },
    ...choices.map((c, i): MenuItem => {
      const first = i === 0 || choices[i - 1]!.harness !== c.harness
      return {
        id: `${c.harness}:${c.model ?? ''}`,
        section: first ? c.harnessLabel : undefined,
        separator: first,
        label: modelName(c),
        text: modelName(c),
        // 能用时只标桥接（直连、自带是常态，不占一行）；不能用时写原因
        description: c.available ? (c.pairing?.mode === 'bridge' ? pairingText(c.pairing) : undefined) : c.reason,
        hint: c.isDefault ? '默认' : undefined,
        disabled: !c.available,
        checked: same(c, value),
        onSelect: () => onChange({ harness: c.harness, model: c.model }),
      }
    }),
  ]

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn btn-ghost btn-sm stw-runtime"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`管家用的 harness 与模型：${text}${value ? '' : '（默认）'}`}
        title="换管家用的 harness 与模型"
        disabled={q.loading && !q.data}
        onClick={() => setOpen(true)}
      >
        <span className="stw-runtime-dot" style={{ '--hue': current ? harnessHue(current.harness) : 'var(--text-3)' } as CSSProperties} aria-hidden />
        <span className="truncate">{text}</span>
        <ChevronDown className="stw-runtime-chev" aria-hidden />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={btn} items={items} placement="top-start" ariaLabel="管家用的 harness 与模型" minWidth={280} />
    </>
  )
}
