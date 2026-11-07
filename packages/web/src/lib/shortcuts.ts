import { useEffect } from 'react'
import { openCreateRequirement, toggleSidebar, toggleSteward } from './ui-store'

/** 全局快捷键（体验基线 10）。⌘K 由命令面板自己监听。 */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** 'mod+j' → Mac 上 '⌘J'，其他平台 'Ctrl J'；单键原样大写。用于 tooltip 与 <Kbd>。 */
export function shortcutLabel(combo: string): string {
  const parts = combo.toLowerCase().split('+')
  const key = parts.pop()!.toUpperCase()
  const mods = parts.map((m) => (m === 'mod' ? (isMac ? '⌘' : 'Ctrl') : m === 'shift' ? (isMac ? '⇧' : 'Shift') : m === 'alt' ? (isMac ? '⌥' : 'Alt') : m))
  if (!mods.length) return key
  return isMac ? mods.join('') + key : [...mods, key].join(' ')
}

export const SHORTCUTS = {
  steward: 'mod+j',
  palette: 'mod+k',
  sidebar: 'mod+b',
  createRequirement: 'c',
} as const

/** 焦点在可输入元素里（或有对话框打开）时，单键快捷键不生效。 */
function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

/** 挂在 app.tsx：⌘J 管家面板、⌘B 收起侧栏、C 新建需求。 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      if (mod && !e.shiftKey && !e.altKey && k === 'j') {
        e.preventDefault()
        toggleSteward()
      } else if (mod && !e.shiftKey && !e.altKey && k === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (!mod && !e.altKey && !e.shiftKey && k === 'c' && !typing(e)) {
        e.preventDefault()
        openCreateRequirement()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
