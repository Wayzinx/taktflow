import type { ReactNode } from 'react'
import { shortcutLabel } from '../../lib/shortcuts'
import './primitives.css'

/**
 * 键帽：combo 按平台显示（'mod+j' → ⌘J / Ctrl J）；也可以直接写 children。
 *   <Kbd combo="mod+k" />  <Kbd>Esc</Kbd>
 * tooltip 文案用 withShortcut('管家', 'mod+j') → "管家（⌘J）"。
 */
export function Kbd({ combo, children, onDark }: { combo?: string; children?: ReactNode; /** 放在深色导轨上 */ onDark?: boolean }) {
  return <kbd className={`ui-kbd mono${onDark ? ' on-dark' : ''}`}>{children ?? (combo ? shortcutLabel(combo) : null)}</kbd>
}

export const withShortcut = (label: string, combo: string) => `${label}（${shortcutLabel(combo)}）`
