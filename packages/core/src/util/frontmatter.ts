import { parse } from 'yaml'

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text)
  if (!opening) return { data: {}, body: text }
  const remainder = text.slice(opening[0].length)
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remainder)
  if (!closing) throw new Error('Frontmatter 缺少结束分隔符')
  let data: unknown
  try {
    data = parse(remainder.slice(0, closing.index))
  } catch (cause) {
    throw new Error('Frontmatter YAML 解析失败', { cause })
  }
  if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
    throw new Error('Frontmatter 必须是 YAML 映射')
  }
  return {
    data: (data ?? {}) as Record<string, unknown>,
    body: remainder.slice(closing.index + closing[0].length),
  }
}
