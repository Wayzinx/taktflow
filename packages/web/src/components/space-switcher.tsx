import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronsUpDown, LayoutGrid, Plus, Search } from 'lucide-react'
import type { SpaceSummary } from '@taktflow/core'
import { useAsync } from '../api'
import { navigate, useLocation } from '../lib/router'
import { spacePath } from '../lib/space'
import { openCreateSpace } from '../lib/ui-store'
import { Popover } from './ui'
import './space-switcher.css'

/** 空间色方块：没设颜色时用中性色。/spaces 卡片与新建对话框也用。 */
export function SpaceMark({ space, size = 22 }: { space: Pick<SpaceSummary, 'name' | 'color'>; size?: number }) {
  return (
    <span className="space-mark" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.5), ...(space.color ? { background: space.color, color: 'var(--text-inverse)' } : {}) }}>
      {[...space.name.trim()][0]?.toUpperCase() ?? '·'}
    </span>
  )
}

/**
 * 导轨左上角：产品名 + 当前空间，点开切换。走浮层原语（门户、翻转、Esc、退出动画），宽 300px，最高 60vh。
 * 超过 5 个空间出现搜索；同名空间在名称下显示 id；底部是"新建空间"和"管理全部空间"。
 */
export function SpaceSwitcher({ fallbackName }: { fallbackName?: string }) {
  const { spaceId } = useLocation()
  const q = useAsync((ds) => ds.spaces(), [])
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const spaces = useMemo(() => q.data ?? [], [q.data])
  const current = spaces.find((s) => s.id === spaceId) ?? (spaceId ? undefined : spaces[0])
  const dupNames = useMemo(() => {
    const n = new Map<string, number>()
    spaces.forEach((s) => n.set(s.name, (n.get(s.name) ?? 0) + 1))
    return n
  }, [spaces])
  const searchable = spaces.length > 5
  const t = term.trim().toLowerCase()
  const shown = t ? spaces.filter((s) => s.name.toLowerCase().includes(t) || s.id.includes(t) || s.description?.toLowerCase().includes(t)) : spaces

  const close = () => {
    setOpen(false)
    setTerm('')
  }
  const toggle = () => {
    if (open) return close()
    setOpen(true)
    // 打开后焦点给搜索框或当前项
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('.space-search input, .space-option[aria-checked="true"], .space-option')?.focus())
  }
  const pick = (id: string) => {
    close()
    if (id !== current?.id) navigate(spacePath(id))
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('.space-option, .space-foot-btn') ?? [])]
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Enter' && i < 0 && shown[0]) {
      e.preventDefault()
      pick(shown[0].id)
      return
    }
    const next = { ArrowDown: (i + 1) % items.length, ArrowUp: i < 0 ? items.length - 1 : (i + items.length - 1) % items.length, Home: 0, End: items.length - 1 }[e.key]
    if (next === undefined || ((e.key === 'Home' || e.key === 'End') && i < 0)) return
    e.preventDefault()
    items[next]?.focus()
  }

  const name = current?.name ?? fallbackName ?? ''
  return (
    <div className="space-switcher">
      <button ref={trigger} type="button" className="space-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`当前空间 ${name}，切换空间`} title={current && current.name !== current.id ? `${name}（${current.id}）` : name} onClick={toggle}>
        {/* 产品名由 Logo 表达，这里整行给空间名；同名空间靠下拉里的 id 区分，悬停显示 id */}
        <span className="space-trigger-text">
          <span className="space-trigger-name truncate">{name || <span className="space-trigger-sk" aria-hidden />}</span>
        </span>
        <ChevronsUpDown className="space-trigger-icon" aria-hidden />
      </button>
      <Popover open={open} onClose={close} anchor={trigger} placement="bottom-start" offset={8} className="space-pop" ariaLabel="切换项目空间">
        <div ref={list} className="space-menu" role="menu" onKeyDown={onKey}>
          {searchable && (
            <label className="space-search">
              <Search aria-hidden />
              <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={`搜索 ${spaces.length} 个空间`} aria-label="搜索空间" />
            </label>
          )}
          <div className="space-menu-label">项目空间</div>
          <div className="space-list">
            {shown.map((s) => {
              const on = s.id === current?.id
              return (
                <button key={s.id} type="button" role="menuitemradio" aria-checked={on} className={`space-option${on ? ' on' : ''}`} onClick={() => pick(s.id)}>
                  <SpaceMark space={s} />
                  <span className="space-option-text">
                    <span className="space-option-name truncate">{s.name}</span>
                    {(dupNames.get(s.name) ?? 0) > 1 && <span className="space-option-id mono truncate">{s.id}</span>}
                    <span className="space-option-meta">
                      {s.requirements ? (
                        <>
                          <span className="num">{s.requirements}</span> 个需求 · <span className="num">{s.active}</span> 个进行中
                        </>
                      ) : (
                        '还没有需求'
                      )}
                      {!!s.risks && <span className="space-option-risk"> · {s.risks} 个风险</span>}
                    </span>
                  </span>
                  {on && <Check className="space-check" aria-hidden />}
                </button>
              )
            })}
            {shown.length === 0 && <div className="space-none">没有匹配「{term}」的空间</div>}
          </div>
          <div className="space-menu-foot">
            <button type="button" role="menuitem" className="space-foot-btn" onClick={() => (close(), openCreateSpace())}>
              <Plus aria-hidden />
              新建空间
            </button>
            <button type="button" role="menuitem" className="space-foot-btn" onClick={() => (close(), navigate('/spaces'))}>
              <LayoutGrid aria-hidden />
              管理全部空间
            </button>
          </div>
        </div>
      </Popover>
    </div>
  )
}
