import './primitives.css'

/**
 * 开关（启用 / 停用）：role="switch"，开 = 强调色。立即生效的设置用它；需要再确认的写操作用按钮 + ReasonDialog。
 *   <Switch on={a.enabled} label={`停用「${a.title}」`} onChange={toggle} />
 */
export function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="ui-switch" disabled={disabled} onClick={() => onChange(!on)}>
      <span className="ui-switch-knob" />
    </button>
  )
}
