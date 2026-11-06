import { canonicalJson, sha256 } from '../util/hash.js'
import { readJsonFile, toJsonText, writeFileAtomic } from './fs-utils.js'

export const ZERO_HASH = '0'.repeat(64)
export const SHA256 = /^[a-f0-9]{64}$/

export function chainHash(prevHash: string, payload: unknown): string {
  return sha256(prevHash + canonicalJson(payload))
}

export interface ChainAnchor { lastSeq: number; lastHash: string; updatedAt: string }

export async function readAnchor(file: string): Promise<ChainAnchor | undefined> {
  const value = await readJsonFile<unknown>(file)
  if (value === undefined) return undefined
  const anchor = value as Partial<ChainAnchor> | null
  if (anchor === null || typeof anchor !== 'object'
    || !Number.isSafeInteger(anchor.lastSeq) || (anchor.lastSeq as number) < 1
    || typeof anchor.lastHash !== 'string' || !SHA256.test(anchor.lastHash)
    || typeof anchor.updatedAt !== 'string') throw new Error(`链尾锚点损坏：${file}`)
  return anchor as ChainAnchor
}

export async function writeAnchor(file: string, tail: { seq: number; hash: string }): Promise<void> {
  await writeFileAtomic(file, toJsonText({ lastSeq: tail.seq, lastHash: tail.hash, updatedAt: new Date().toISOString() }))
}
