import { randomUUID } from 'node:crypto'
import { canonicalJson, getObject, isDocumentReview, type Actor, type DefectView, type EvalCaseView, type ProjectStores, type QualityEventInput, type QualityEventPayloads } from '@taktflow/core'
import { ApiError } from './errors.js'
import { CASE_STATUSES, RESOLUTIONS, VALIDITIES, qualityDefect, qualityInvocation, qualityStore } from './quality-read.js'
import { array, asset, attribution, hash, human, object, oneOf, positive, qualityActor, strings } from './quality-validation.js'
import { safeId, text } from './validation.js'
import { serialize } from './stale.js'

export { readQuality, type QualityReadOp } from './quality-read.js'
export type QualityWriteOp = 'defect.create' | 'defect.update' | 'attribution.record' | 'evalcase.add' | 'evalcase.update' | 'candidate.create' | 'eval.start'

async function observations(stores: ProjectStores, ids: string[], requirementId: string): Promise<void> {
  const known = new Map((await qualityStore(stores).observations()).map((item) => [item.id, item]))
  for (const id of ids) {
    const item = known.get(id)
    if (!item) throw new ApiError(404, `观察不存在：${id}`)
    if (item.requirementId !== requirementId) throw new ApiError(400, `观察不属于需求 ${requirementId}：${id}`)
  }
}

function patchOf(value: unknown): QualityEventPayloads['defect.updated']['patch'] {
  const input = object(value, 'patch')
  const allowed = ['title', 'severity', 'validity', 'resolution', 'duplicateOf', 'addObservations', 'removeObservations']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new ApiError(400, `不能修改缺陷字段：${key}`)
  return {
    ...(input.title === undefined ? {} : { title: text(input.title, 'title') }),
    ...(input.severity === undefined ? {} : { severity: oneOf(input.severity, ['blocker', 'major', 'minor'], 'severity') }),
    ...(input.validity === undefined ? {} : { validity: oneOf(input.validity, VALIDITIES, 'validity') }),
    ...(input.resolution === undefined ? {} : { resolution: oneOf(input.resolution, RESOLUTIONS, 'resolution') }),
    ...(input.duplicateOf === undefined ? {} : { duplicateOf: text(input.duplicateOf, 'duplicateOf') }),
    ...(input.addObservations === undefined ? {} : { addObservations: strings(input.addObservations, 'addObservations') }),
    ...(input.removeObservations === undefined ? {} : { removeObservations: strings(input.removeObservations, 'removeObservations') }),
  }
}

async function checkDuplicate(stores: ProjectStores, defect: Pick<DefectView, 'id' | 'requirementId' | 'validity' | 'duplicateOf'>): Promise<void> {
  if (defect.validity !== 'duplicate') return
  let id = text(defect.duplicateOf, 'duplicateOf')
  const visited = new Set([defect.id])
  for (;;) {
    if (visited.has(id)) throw new ApiError(400, '重复缺陷关系不能成环')
    visited.add(id)
    const target = await qualityDefect(stores, id)
    if (target.requirementId !== defect.requirementId) throw new ApiError(400, '只能标记同一需求的重复缺陷')
    if (target.validity !== 'duplicate') return
    id = text(target.duplicateOf, 'duplicateOf')
  }
}

export async function writeQuality(stores: ProjectStores, op: QualityWriteOp, params: Record<string, string | undefined>, input: Record<string, unknown>, actor: Actor): Promise<unknown> {
  const quality = qualityStore(stores)
  qualityActor(actor)
  if (op === 'eval.start') throw new ApiError(501, 'eval.start 已登记；一期 E 不执行评测，等待 G 接入只读回放执行器')
  if (op === 'defect.create' || op === 'defect.update' || op === 'attribution.record') human(actor)
  const append = (events: QualityEventInput[], baseRevisions: Record<string, number>) => quality.append(events, {
    idempotencyKeys: events.map(() => `${op}:${randomUUID()}`), baseRevisions,
  })
  switch (op) {
    case 'defect.create': return serialize(stores.projectDir, async () => {
      const requirementId = safeId(text(input.requirementId, 'requirementId'))
      if (!await stores.workspaces.getRequirement(requirementId)) throw new ApiError(404, '需求不存在')
      const ids = strings(input.observations, 'observations', true)
      await observations(stores, ids, requirementId)
      const existing = await quality.defects({ requirement: requirementId })
      let index = 1
      while (existing.some((item) => item.id === `DEF-${requirementId}-${index}`)) index++
      const id = input.id === undefined ? `DEF-${requirementId}-${index}` : text(input.id, 'id')
      const defect = {
        id, requirementId, title: text(input.title, 'title'), severity: oneOf(input.severity, ['blocker', 'major', 'minor'], 'severity'), observations: ids,
        validity: input.validity === undefined ? 'valid' as const : oneOf(input.validity, VALIDITIES, 'validity'),
        resolution: input.resolution === undefined ? 'open' as const : oneOf(input.resolution, RESOLUTIONS, 'resolution'),
        ...(input.duplicateOf === undefined ? {} : { duplicateOf: text(input.duplicateOf, 'duplicateOf') }), createdBy: actor, createdAt: new Date().toISOString(),
      }
      await checkDuplicate(stores, defect)
      await append([{ type: 'defect.created', actor, data: { defect } }], { [`defect:${id}`]: 0 })
      return quality.defect(id)
    })
    case 'defect.update': return serialize(stores.projectDir, async () => {
      const id = text(params.id ?? input.id, 'id')
      const baseRevision = positive(input.baseRevision, 'baseRevision')
      const reason = text(input.reason, 'reason')
      const defect = await qualityDefect(stores, id)
      const patch = patchOf(input.patch ?? {})
      const revisions = { [`defect:${id}`]: baseRevision }
      const events: QualityEventInput[] = []
      if (input.merge !== undefined) {
        const merge = object(input.merge, 'merge')
        const sourceId = text(merge.id, 'merge.id')
        if (sourceId === id) throw new ApiError(400, '不能合并自身')
        const source = await qualityDefect(stores, sourceId)
        if (source.requirementId !== defect.requirementId) throw new ApiError(400, '只能合并同一需求的缺陷')
        await checkDuplicate(stores, { ...source, validity: 'duplicate', duplicateOf: id })
        patch.addObservations = [...new Set([...(patch.addObservations ?? []), ...source.observations])]
        const sourceRevision = positive(merge.baseRevision, 'merge.baseRevision')
        revisions[`defect:${sourceId}`] = sourceRevision
        events.push({ type: 'defect.updated', actor, data: { id: sourceId, baseRevision: sourceRevision, patch: { validity: 'duplicate', duplicateOf: id }, reason, by: actor } })
      }
      if (!Object.keys(patch).length) throw new ApiError(400, 'patch 或 merge 至少提供一项修改')
      await observations(stores, patch.addObservations ?? [], defect.requirementId)
      if (patch.removeObservations?.some((value) => !defect.observations.includes(value))) throw new ApiError(400, '不能移除未关联的观察')
      if (patch.removeObservations?.some((value) => patch.addObservations?.includes(value))) throw new ApiError(400, '同一观察不能同时添加和移除')
      await checkDuplicate(stores, { ...defect, ...patch })
      if (input.merge !== undefined && (patch.validity ?? defect.validity) === 'duplicate') throw new ApiError(400, '合并目标不能是重复缺陷')
      events.unshift({ type: 'defect.updated', actor, data: { id, baseRevision, patch, reason, by: actor } })
      await append(events, revisions)
      return quality.defect(id)
    })
    case 'attribution.record': {
      const defectId = text(params.defectId ?? input.defectId, 'defectId')
      await qualityDefect(stores, defectId)
      const baseRevision = positive(input.baseRevision, 'baseRevision')
      const value = attribution(input.attribution, actor)
      await append([{ type: 'attribution.recorded', actor, data: { defectId, baseRevision, attribution: value } }], { [`defect:${defectId}`]: baseRevision })
      return quality.defect(defectId)
    }
    case 'evalcase.add': {
      const value = object(input.case, 'case')
      const frozen = object(value.frozen, 'frozen')
      const invocationId = text(frozen.invocationId, 'invocationId')
      const captured = await qualityInvocation(stores, invocationId)
      if (captured.invocation.review?.part !== 'reviewer' || captured.inputSnapshot.render.template.kind !== 'review-reviewer'
        || !captured.inputSnapshot.inputs.some((item) => item.role === 'target')
        || !await isDocumentReview(stores, captured.invocation.runId, captured.invocation.nodeId)) throw new ApiError(400, '一期评测样本只支持文档评审者调用')
      const inputSnapshotId = text(frozen.inputSnapshotId, 'inputSnapshotId')
      if (inputSnapshotId !== captured.invocation.inputSnapshotId) throw new ApiError(400, '样本输入快照与调用不一致')
      const kind = oneOf(value.kind, ['must_catch', 'clean'], 'kind')
      const expectation = object(value.expectation, 'expectation')
      if (expectation.kind !== kind) throw new ApiError(400, 'expectation.kind 与 kind 不一致')
      const target = object(value.target, 'target')
      const origin = value.origin === undefined ? undefined : object(value.origin, 'origin')
      const item: EvalCaseView = {
        id: text(value.id, 'id'), revision: 1, kind,
        target: { role: text(target.role, 'role'), template: asset(target.template) }, frozen: { invocationId, inputSnapshotId },
        expectation: kind === 'must_catch' ? { kind, issue: text(expectation.issue, 'issue'), ...(expectation.issueKey === undefined ? {} : { issueKey: text(expectation.issueKey, 'issueKey') }) }
          : { kind, allowedSeverities: strings(expectation.allowedSeverities, 'allowedSeverities').map((severity) => oneOf(severity, ['minor', 'nit'], 'severity')) },
        status: value.status === undefined ? 'proposed' : oneOf(value.status, CASE_STATUSES, 'status'),
        ...(origin === undefined ? {} : { origin: { invocationId: text(origin.invocationId, 'origin.invocationId'), ...(origin.defectId === undefined ? {} : { defectId: text(origin.defectId, 'origin.defectId') }) } }),
      }
      if (value.revision !== undefined && value.revision !== 1) throw new ApiError(400, '新增样本 revision 必须为 1')
      if (item.target.role !== captured.recipe.role || canonicalJson(item.target.template) !== canonicalJson(captured.recipe.template)) throw new ApiError(400, '样本角色和职责模板必须与冻结调用一致')
      if (item.origin && item.origin.invocationId !== invocationId) throw new ApiError(400, '样本来源与冻结调用不一致')
      if (kind === 'clean') human(actor)
      else {
        const defect = await qualityDefect(stores, text(item.origin?.defectId, 'origin.defectId'))
        if (defect.validity !== 'valid' || defect.attribution?.status !== 'confirmed'
          || !defect.attribution.escapes.some((escape) => escape.invocationId === invocationId && escape.verdict === 'should_have_caught')) {
          throw new ApiError(400, 'must_catch 样本需要有效缺陷及已确认的 should_have_caught 漏拦调用')
        }
      }
      await append([{ type: 'evalcase.added', actor, data: { case: item } }], { [`evalcase:${item.id}`]: 0 })
      return item
    }
    case 'evalcase.update': {
      const id = text(params.id ?? input.id, 'id')
      if (!(await quality.evalcases()).some((item) => item.id === id)) throw new ApiError(404, '样本不存在')
      const baseRevision = positive(input.baseRevision, 'baseRevision')
      await append([{ type: 'evalcase.updated', actor, data: { id, baseRevision, status: oneOf(input.status, CASE_STATUSES, 'status'), reason: text(input.reason, 'reason'), by: actor } }], { [`evalcase:${id}`]: baseRevision })
      return (await quality.evalcases()).find((item) => item.id === id)
    }
    case 'candidate.create': {
      const replaces = array(input.replaces, 'replaces', (item) => ({ asset: asset(item.asset), content: hash(item.content, 'content') }))
      for (const item of replaces) {
        try { await getObject(stores, item.content) }
        catch (error) {
          if (error instanceof Error && error.message === `对象缺失：${item.content}`) throw new ApiError(404, error.message)
          throw error
        }
      }
      const exec = input.exec === undefined ? undefined : object(input.exec, 'exec')
      return quality.createCandidate({ replaces, createdBy: actor, note: text(input.note, 'note'),
        ...(input.params === undefined ? {} : { params: object(input.params, 'params') }),
        ...(exec === undefined ? {} : { exec: { ...(exec.model === undefined ? {} : { model: text(exec.model, 'model') }), ...(exec.effort === undefined ? {} : { effort: text(exec.effort, 'effort') }) } }),
      })
    }
  }
}
