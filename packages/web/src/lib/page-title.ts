import { isValidElement, type ReactNode } from 'react'

export interface Crumb {
  label: ReactNode
  to?: string
}

/** ReactNode → 纯文本：面包屑里常见 <span className="mono">REQ-001</span> 这种写法，标签页标题只要字。 */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ''
}

/**
 * 空间内页面的面包屑统一以空间名开头（可点回总览），页面只声明自己那几级（TF-043）。
 * 页面自己已经把空间名放在第一级（总览的旧写法）时不重复；全局页（全部空间、管家）不传 space。
 */
export function withSpaceCrumb(items: Crumb[], space: string | undefined): Crumb[] {
  if (!space) return items
  const rest = nodeText(items[0]?.label) === space ? items.slice(1) : items
  return [{ label: space, to: '/' }, ...rest]
}
