import { canonicalJson, sha256 } from '../util/hash.js'

export const ZERO_HASH = '0'.repeat(64)
export interface ChainLink { seq: number; prevHash: string; hash: string }
export interface ChainAnchor { seq: number; hash: string }

// 与事件存储保持相同规则：前项哈希 + 规范化后的业务信封（不含链字段）。
export function chainHash(value: ChainLink, payload?: unknown): string {
  const { prevHash, hash: _hash, ...fields } = value
  return sha256(prevHash + canonicalJson(payload ?? fields))
}

export function verifyChain<T extends ChainLink>(text: string, valid: (value: unknown) => value is T, options: {
  payload?: (entry: T) => unknown; ignoreBlankLines?: boolean; requireFinalNewline?: boolean
} = {}): {
  entries: T[]; brokenAt?: number
} {
  const entries: T[] = []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    if (options.ignoreBlankLines && !line.trim()) continue
    const seq = entries.length + 1
    let value: unknown
    try { value = JSON.parse(line) } catch { return { entries, brokenAt: seq } }
    if (!valid(value) || value.seq !== seq || value.prevHash !== (entries.at(-1)?.hash ?? ZERO_HASH)
      || value.hash !== chainHash(value, options.payload?.(value))) return { entries, brokenAt: seq }
    entries.push(value)
  }
  // 没有换行的尾部可能是崩溃留下的半次追加，不自动接着写。
  if (options.requireFinalNewline !== false && text && !text.endsWith('\n')) return { entries, brokenAt: entries.length || 1 }
  return { entries }
}

export function checkAnchor(entries: ChainLink[], anchor?: ChainAnchor): { anchorBehind: boolean; brokenAt?: number } {
  if (!anchor) return { anchorBehind: entries.length > 0 }
  if (!Number.isSafeInteger(anchor.seq) || anchor.seq < 0 || anchor.seq > entries.length) {
    return { anchorBehind: false, brokenAt: entries.length + 1 }
  }
  if (anchor.hash !== (anchor.seq === 0 ? ZERO_HASH : entries[anchor.seq - 1]!.hash)) {
    return { anchorBehind: false, brokenAt: anchor.seq || 1 }
  }
  return { anchorBehind: anchor.seq < entries.length }
}
