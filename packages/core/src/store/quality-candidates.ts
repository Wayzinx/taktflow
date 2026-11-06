import path from 'node:path'
import type { Candidate } from '../quality.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { assertNoSymlinks, readJsonFile, toJsonText } from './fs-utils.js'
import { getObject } from './objects.js'
import { materializeReadonlyFiles } from './readonly-files.js'
import type { CandidateInput } from './quality-store.js'

/** 创建时间是审计元数据；相同内容、创建者和说明的重试仍指向同一候选包。 */
export function candidateId(input: CandidateInput): string {
  return sha256(canonicalJson({ replaces: input.replaces, params: input.params, exec: input.exec, createdBy: input.createdBy, note: input.note }))
}

export async function prepareCandidate(taktDir: string, candidate: Candidate): Promise<void> {
  if (candidate.candidateId !== candidateId(candidate)) throw new Error('候选包内容与 candidateId 不一致')
  const dir = path.join(taktDir, 'quality', 'evals', 'candidates', candidate.candidateId)
  await assertNoSymlinks(taktDir, dir)
  const files = new Map<string, Buffer>([['candidate.json', Buffer.from(toJsonText(candidate))]])
  for (const replacement of candidate.replaces) files.set(`objects/${replacement.content}`, await getObject(taktDir, replacement.content))
  await materializeReadonlyFiles(dir, files)
}

/** 兼容目录已发布、日志尚未提交的重试，保留首次创建时间。 */
export async function storedCandidate(taktDir: string, input: CandidateInput): Promise<Candidate | undefined> {
  const file = path.join(taktDir, 'quality', 'evals', 'candidates', candidateId(input), 'candidate.json')
  await assertNoSymlinks(taktDir, file)
  const stored = await readJsonFile<Candidate>(file)
  if (stored && (stored.candidateId !== candidateId(input) || candidateId(stored) !== stored.candidateId)) throw new Error('候选包内容地址损坏')
  return stored
}
