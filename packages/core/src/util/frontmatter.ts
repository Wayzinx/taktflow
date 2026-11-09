import { parse, parseDocument } from 'yaml'
import { isDeepStrictEqual } from 'node:util'

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

/** 用 YAML 文档节点做局部替换，保留未知键、注释、键序和未修改的正文。 */
export function patchFrontmatter(text: string, patch: Record<string, unknown>, instructions?: string): string {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text)
  const remainder = opening ? text.slice(opening[0].length) : ''
  const closing = opening ? /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remainder) : null
  const parsed = parseFrontmatter(text)
  const document = parseDocument(closing ? remainder.slice(0, closing.index) : '')
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) document.delete(key)
    else document.set(key, value)
  }
  const yaml = document.toString()
  const result = `${opening?.[0] ?? '---\n'}${yaml}${closing?.[0] || '---\n'}${instructions ?? parsed.body}`
  const written = parseFrontmatter(result)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null ? Object.hasOwn(written.data, key) : !isDeepStrictEqual(written.data[key], value)) throw new Error(`角色 ${key} 写回校验失败，请检查 YAML 格式后重试`)
  }
  return result
}
