import type { BeeProp } from '../components/mascot/bee-markup'

/**
 * 角色 → 蜂手里的道具（docs/design/27 §1、30 §1）：一眼看出是谁，不用读字。
 * 角色名是空间自定义的，按名字里的关键词认；认不出的按名字哈希到一个固定道具，同名全站一致。
 */
const RULES: Array<[RegExp, BeeProp]> = [
  [/steward|管家/, 'bell'],
  [/lead|领队|主持/, 'baton'],
  [/plan|dispatch|router|route|调度|规划/, 'mail'],
  [/judge|audit|arbiter|判决|审计/, 'gavel'],
  [/review|verif|evaluat|critic|评审|验收|评测/, 'lens'],
  [/test|qa|automat|测试|用例/, 'tube'],
  [/dev|engineer|implement|coder|build|开发|实现/, 'wrench'],
  [/architect|design|设计|架构/, 'ruler'],
  [/pm|product|analyst|需求|产品/, 'note'],
]
const POOL: BeeProp[] = ['note', 'ruler', 'wrench', 'lens', 'tube', 'gavel', 'mail']

export function roleProp(role?: string): BeeProp | undefined {
  if (!role) return undefined
  const r = role.toLowerCase()
  for (const [re, prop] of RULES) if (re.test(r)) return prop
  return POOL[[...r].reduce((s, c) => s + c.charCodeAt(0), 0) % POOL.length]
}

/**
 * 角色 → 蜂的身体色（docs/design/30 §1）：同一个角色全站同色，一眼分得开不同角色。
 * 六个色相各有本色和深色两档，内置角色各占一档；其余角色按名字哈希。
 * --c-4（琥珀）留给管家和 Lead 的蜂蜜色，--c-7（灰）留给没有角色的。
 */
const HUES = [1, 2, 3, 5, 6, 8]
const SHADES = HUES.flatMap((n) => [`var(--c-${n})`, `color-mix(in oklch, var(--c-${n}) 70%, var(--text))`])
const BUILTIN: Record<string, number> = { pm: 0, architect: 8, dev: 4, 'test-designer': 10, automation: 2, reviewer: 6, judge: 11, verifier: 3, evaluator: 1, auditor: 9, 'wiki-writer': 5 }

export function roleHue(role?: string): string {
  if (!role) return 'var(--c-7)'
  if (/^(steward|lead)$/.test(role)) return 'var(--honey)'
  return SHADES[BUILTIN[role] ?? [...role].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7) % SHADES.length]!
}
