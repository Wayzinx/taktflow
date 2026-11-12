import type { StewardCitation } from '@taktflow/core'

/** 去掉 [n] 引用，连同只包着引用的括号（「已交付（[1]）」→「已交付」）：复制、会话列表摘要用。 */
export const stripCitations = (text: string) => text.replace(/\s*[（(]\s*(?:\[\d+\][\s,，、]*)+[）)]/g, '').replace(/\[\d+\]/g, '')

/** 历史摘要可能在 Markdown 链接中间截断，显示时仍然只留正文。 */
export const plainSummary = (text: string) => stripCitations(text)
  .replace(/^```.*$/gm, '')
  .replace(/^\s*\|?[\s:|-]*-{2,}[\s:|-]*$/gm, '')
  .replace(/\[([^\]\n]+)\]\([^)\s]*\)?/g, '$1')
  .replace(/\*\*|__|`/g, '')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\s*\|\s*/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * 复制成可以直接转发的纯文本：去掉粗体 / 行内代码 / 标题 / 代码围栏等标记，链接写成「文字（地址）」，
 * [n] 留在原处，末尾按编号列出来源（站内地址补成绝对地址）。
 */
export function plainWithSources(text: string, citations: StewardCitation[] = [], origin = ''): string {
  const abs = (href: string) => (/^https?:\/\//.test(href) ? href : `${origin}${href}`)
  const body = text
    .replace(/^```.*\n?/gm, '')
    .replace(/\[([^\]\n]+)\]\(\[(\d+)\]\)/g, '$1[$2]')
    .replace(/\[([^\]\n]+)\]\(((?:\/|https?:\/\/)[^)\s]*)\)/g, (_, label: string, href: string) => `${label}（${abs(href)}）`)
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .trim()
  if (!citations.length) return body
  return `${body}\n\n来源：\n${citations.map((c, i) => `[${i + 1}] ${c.label} ${abs(c.href)}`).join('\n')}`
}
