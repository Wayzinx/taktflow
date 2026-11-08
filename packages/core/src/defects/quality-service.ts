import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ProjectStores, QualityStore } from '../interfaces.js'
import type { DefectDetail, DefectReportRequest, DefectUpdateRequest } from '../api.js'
import type { Actor, Defect, Observation } from '../types.js'
import { assertRequirementId } from '../store/paths.js'
import { withFileLock } from '../store/file-lock.js'

export function requireQuality(stores: ProjectStores): QualityStore {
  if (!stores.quality) throw new Error('未挂接质量日志；请使用 openProject 加载空间后重试')
  return stores.quality
}
export function requireReason(reason: string): string {
  if (!reason?.trim()) throw new Error('必须填写 reason；请说明本次变更的原因')
  return reason.trim()
}
export function requireHuman(by: Actor): void {
  if (by.type !== 'human') throw new Error('此操作必须由人确认；请使用人工身份提交')
}
export function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('baseRevision 不合法；请重新读取缺陷版本后提交')
}
export async function qualityRequirement(stores: ProjectStores, req: string): Promise<QualityStore> {
  assertRequirementId(req)
  const quality = requireQuality(stores)
  if (!await stores.workspaces.getRequirement(req)) throw new Error(`需求不存在：${req}；请核对需求 id`)
  return quality
}
export async function readQualityDefect(stores: ProjectStores, req: string, id: string): Promise<DefectDetail> {
  const quality = await qualityRequirement(stores, req)
  if (!/^D-[1-9]\d*$/.test(id)) throw new Error('非法缺陷 id；请使用 D-数字 格式')
  const defect = (await quality.defects(req)).find(item => item.id === id)
  if (!defect) throw new Error(`缺陷不存在：${req}/${id}；请刷新缺陷列表`)
  const observations = await quality.observations({ requirementId: req })
  return { ...defect, observationsDetail: observations.filter(item => defect.observations?.includes(item.id)) }
}

export async function createQualityDefect(stores: ProjectStores, req: string, request: DefectReportRequest, by: Actor): Promise<DefectDetail> {
  requireHuman(by)
  const reason = requireReason(request.reason ?? '')
  const quality = await qualityRequirement(stores, req)
  if (!request.title?.trim() || !request.description?.trim() || !['critical', 'major', 'minor'].includes(request.severity)) {
    throw new Error('缺陷信息不完整；请提供标题、描述和合法严重性')
  }
  if (request.acs?.some(ac => !/^AC-\d+(?:-\d+)?$/.test(ac))) throw new Error('验收标准 id 不合法；请使用 AC-数字 格式')
  return withFileLock(join(stores.workspaces.dir(req), 'defects'), async () => {
    const selected = [...new Set(request.observations ?? [])]
    const observations = await quality.observations({ requirementId: req })
    if (selected.some(id => !observations.some(item => item.id === id))) throw new Error('观察不存在或不属于本需求；请刷新后重新选择')
    const existing = await quality.defects(req)
    const id = `D-${Math.max(0, ...existing.map(item => Number(item.id.slice(2)))) + 1}`
    const at = new Date().toISOString(), token = randomUUID()
    const entries: Parameters<QualityStore['append']>[0] = []
    if (!selected.length) {
      const observation: Observation = { id: `external:${token}`, source: 'external', kind: 'report', requirementId: req,
        title: request.title, detail: request.description, severity: request.severity, at, by }
      selected.push(observation.id)
      entries.push({ kind: 'observation.recorded', key: observation.id, requirementId: req, data: { ...observation, reason }, actor: by })
    }
    const defect: Defect = { id, requirementId: req, title: request.title, description: request.description, severity: request.severity,
      foundAt: at, reportedBy: by, acs: request.acs, evidence: request.evidence, links: request.links,
      status: 'open', observations: selected, validity: 'unconfirmed', resolution: 'open' }
    entries.push({ kind: 'defect.created', key: `defect:create:${token}`, requirementId: req, data: { ...defect, reason }, actor: by })
    // 创建没有既有 revision；唯一 id 冲突仍由日志提交锁检查。
    await quality.append(entries)
    return readQualityDefect(stores, req, id)
  })
}

export async function updateQualityDefect(stores: ProjectStores, req: string, id: string, request: DefectUpdateRequest, by: Actor): Promise<DefectDetail> {
  requireHuman(by); requireRevision(request.baseRevision)
  const reason = requireReason(request.reason), current = await readQualityDefect(stores, req, id)
  if (request.validity !== undefined && !['unconfirmed', 'valid', 'not_defect', 'duplicate'].includes(request.validity)) throw new Error('有效性不合法；请重新选择')
  if (request.resolution !== undefined && !['open', 'claimed_fixed', 'verified_fixed', 'accepted_risk', 'reopened'].includes(request.resolution)) throw new Error('处理状态不合法；请重新选择')
  const validity = request.validity ?? current.validity
  const duplicateOf = request.duplicateOf ?? current.duplicateOf
  if (validity === 'duplicate') {
    if (!duplicateOf || duplicateOf === id) throw new Error('重复缺陷必须指向另一缺陷；请选择目标缺陷')
    const seen = new Set([id])
    let target: string | undefined = duplicateOf
    while (target) {
      if (seen.has(target)) throw new Error('重复关系形成循环；请重新选择目标缺陷')
      seen.add(target)
      const next = await readQualityDefect(stores, req, target)
      target = next.validity === 'duplicate' ? next.duplicateOf : undefined
    }
  } else if (request.duplicateOf !== undefined) throw new Error('只有重复缺陷可设置 duplicateOf；请同时选择 duplicate 有效性')
  const patch = { id, ...(request.validity === undefined ? {} : { validity: request.validity }),
    ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
    ...(validity === 'duplicate' ? { duplicateOf } : {}), reason }
  await requireQuality(stores).append([{ kind: 'defect.updated', key: `defect:update:${randomUUID()}`, requirementId: req, data: patch, actor: by }],
    { baseRevision: { defectId: id, revision: request.baseRevision } })
  return readQualityDefect(stores, req, id)
}
