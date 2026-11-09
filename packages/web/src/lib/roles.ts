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
