import { parse, parseDocument } from 'yaml'

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

/**
 * 按字段更新 markdown 的 frontmatter，未提到的字段（含注释、顺序、写法）原样保留。
 * patch 里值为 undefined 的字段删除；数组和对象用 flow 写法（与模板一致，一行写完）。
 * body 传入时替换正文，否则保留原正文。没有 frontmatter 的文本会新建一段。
 */
export function updateFrontmatter(text: string, patch: Record<string, unknown>, body?: string): string {
  const opening = /^(?:﻿)?---[ \t]*\r?\n/.exec(text)
  let yamlText = ''
  let rest = text
  if (opening) {
    const remainder = text.slice(opening[0].length)
    const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remainder)
    if (!closing) throw new Error('Frontmatter 缺少结束分隔符')
    yamlText = remainder.slice(0, closing.index)
    rest = remainder.slice(closing.index + closing[0].length)
  }
  const doc = parseDocument(yamlText)
  if (doc.errors.length) throw new Error('Frontmatter YAML 解析失败', { cause: doc.errors[0] })
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) { doc.delete(key); continue }
    doc.set(key, typeof value === 'object' && value !== null ? doc.createNode(value, { flow: true }) : value)
  }
  const nextBody = body === undefined ? rest : `\n${body.trim()}\n`
  return `---\n${doc.toString({ lineWidth: 0 })}---\n${nextBody}`
}
