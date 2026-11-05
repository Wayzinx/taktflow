import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronsUpDown, Settings2 } from 'lucide-react'
import { useAsync } from '../api'
import { Link, navigate, useLocation } from '../lib/router'
import { spacePath } from '../lib/space'
import './space-switcher.css'

/** 导轨左上角：产品名 + 当前空间，点开切换空间。只有一个空间时不弹菜单。 */
export function SpaceSwitcher({ fallbackName }: { fallbackName?: string }) {
  const { spaceId } = useLocation()
  const q = useAsync((ds) => ds.spaces(), [])
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const spaces = q.data ?? []
  const current = spaces.find((s) => s.id === spaceId) ?? (spaceId ? undefined : spaces[0])
  const multi = spaces.length > 1

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    root.current?.querySelector<HTMLElement>('.space-option[aria-checked="true"], .space-option')?.focus()
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      setOpen(false)
      root.current?.querySelector<HTMLElement>('.space-trigger')?.focus()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(root.current?.querySelectorAll<HTMLElement>('.space-option') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }

  function pick(id: string) {
    setOpen(false)
    if (id !== current?.id) navigate(spacePath(id))
  }

  const name = current?.name ?? fallbackName ?? '…'
  return (
    <div className="space-switcher" ref={root} onKeyDown={onKey}>
      <button
        className="space-trigger"
        aria-haspopup={multi ? 'menu' : undefined}
        aria-expanded={multi ? open : undefined}
        aria-label={`当前空间 ${name}${multi ? '，切换空间' : ''}`}
        onClick={() => multi && setOpen((o) => !o)}
      >
        <span className="space-trigger-text">
          <span className="sb-product">taktflow</span>
          <span className="sb-project truncate">{name}</span>
        </span>
        {multi && <ChevronsUpDown className="space-trigger-icon" aria-hidden />}
      </button>
      {open && (
        <div className="space-menu" role="menu" aria-label="切换项目空间">
          <div className="space-menu-label">项目空间</div>
          {spaces.map((s) => {
            const on = s.id === current?.id
            return (
              <button key={s.id} role="menuitemradio" aria-checked={on} className={`space-option${on ? ' on' : ''}`} onClick={() => pick(s.id)}>
                <span className="space-mark mono" aria-hidden>
                  {s.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="space-option-text">
                  <span className="space-option-name mono truncate">{s.name}</span>
                  <span className="space-option-meta">
                    {s.requirements ? (
                      <>
                        <span className="num">{s.requirements}</span> 个需求 · <span className="num">{s.active}</span> 个进行中
                      </>
                    ) : (
                      '还没有需求'
                    )}
                  </span>
                </span>
                {on && <Check className="space-check" aria-hidden />}
              </button>
            )
          })}
          <div className="space-menu-foot">
            <Link to="/settings" className="space-menu-link" onClick={() => setOpen(false)}>
              <Settings2 aria-hidden />
              当前空间设置
            </Link>
            <span className="space-menu-hint">
              新建空间：在 <span className="mono">--spaces</span> 目录下建子目录，运行 <span className="mono">takt init</span>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
