import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, EvalCase, EvalRun, QualityLogKind } from '../types.js'
import { withFileLock } from '../store/file-lock.js'
import { QualityConflictError } from '../quality/index.js'
import { canonicalJson, sha256 } from '../util/hash.js'

export function qualityStore(stores: ProjectStores) {
  if (!stores.quality) throw new Error('评测需要质量日志；请通过 openProject 打开空间后重试')
  return stores.quality
}

export async function evalView<T extends EvalCase | EvalRun>(stores: ProjectStores, name: 'samples' | 'evaluations'): Promise<T[]> {
  return await qualityStore(stores)[name]() as T[]
}

export function evalRevision(value: unknown): string {
  if (!value) return sha256(canonicalJson(null))
  const { baseRevision: _base, ...plain } = value as Record<string, unknown>
  return sha256(canonicalJson(plain))
}
export interface EvalWriteOptions { by?: Actor; reason?: string; baseRevision?: string; defectRevision?: { defectId: string; revision: number }; requirementId?: string }

export async function appendEvalObject(stores: ProjectStores, kind: Extract<QualityLogKind, 'sample.added' | 'sample.retired' | 'eval.started' | 'eval.finished'>,
  value: EvalCase | EvalRun | { id: string; retiredAt: string }, options: EvalWriteOptions): Promise<boolean> {
  if (!options.reason?.trim()) throw new Error('评测写入必须填写原因；请提供 reason')
  const data = structuredClone(value), frozen = structuredClone(options)
  const quality = qualityStore(stores)
  // 保留读改写锁，避免重复创建与退役互相覆盖；CAS 由质量日志提交锁兜底。
  return withFileLock(join(stores.taktDir, 'quality', 'eval-mutations'), async () => {
    const old = (await evalView(stores, kind.startsWith('sample.') ? 'samples' : 'evaluations')).find(row => row.id === data.id)
    const revision = evalRevision(old)
    if (frozen.baseRevision !== undefined && frozen.baseRevision !== revision) throw new QualityConflictError('评测对象已改变；请重新读取并提交 baseRevision')
    if (kind === 'eval.started' && old) return false
    if (kind === 'sample.added' && old && canonicalJson(old) === canonicalJson(data)) return false
    await quality.append([{ kind, key: `${kind}:${data.id}:${revision}:${evalRevision(data)}`, requirementId: frozen.requirementId,
      actor: frozen.by ?? { type: 'system', id: 'eval' }, data: { ...data, baseRevision: revision, reason: frozen.reason } }],
    { baseRevision: frozen.defectRevision ?? { objectKind: kind.startsWith('sample.') ? 'sample' : 'evaluation', objectId: data.id, revision: frozen.baseRevision ?? revision } })
    return !old
  })
}
