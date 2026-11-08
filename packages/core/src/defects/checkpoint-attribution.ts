import { randomUUID } from 'node:crypto'
import type { EngineDeps, ProjectStores } from '../interfaces.js'
import type { DefectDetail, MissDecisionRequest } from '../api.js'
import type { Actor, DefectAttribution, MissAssessment } from '../types.js'
import { validateSchema } from '../engine/schema.js'
import { snapshotNodes } from '../engine/recipe.js'
import { snapshotMaterials } from '../engine/snapshots.js'
import { assertArtifactPath, assertNodeId, assertRunId } from '../store/paths.js'
import { readOnlyModel } from '../eval/model.js'
import { attributionSchema } from './schema.js'
import { precheckDefect } from './precheck.js'
import { assessCheckpoint, missVerdict, precheckDefectCheckpoints } from './checkpoint-assessment.js'
import { readQualityDefect, requireHuman, requireQuality, requireReason, requireRevision } from './quality-service.js'

const conditionNames = ['existed', 'materialProvided', 'inDuty', 'executed', 'notRaised'] as const
const conditionsSchema = { type: 'object', properties: Object.fromEntries(conditionNames.map(name => [name, { type: 'boolean' }])), required: [] }
const evidenceSchema = { type: 'array', items: { type: 'string' } }
export const checkpointAttributionSchema = { ...attributionSchema, properties: { ...attributionSchema.properties,
  checkpoints: { type: 'array', items: { type: 'object', properties: { checkpointId: { type: 'string' }, conditions: conditionsSchema, evidence: evidenceSchema }, required: ['checkpointId', 'conditions', 'evidence'] } },
}, required: [...attributionSchema.required, 'checkpoints'] }
export interface AttributionWriteOptions { baseRevision: number; reason: string }

async function saveAttribution(stores: ProjectStores, req: string, id: string, attribution: DefectAttribution, by: Actor, options: AttributionWriteOptions): Promise<DefectDetail> {
  const token = randomUUID(), reason = requireReason(options.reason)
  requireRevision(options.baseRevision)
  await requireQuality(stores).append([
    { kind: 'attribution.recorded', key: `attribution:checkpoints:${token}`, requirementId: req, data: { ...attribution, reason }, actor: by },
    { kind: 'defect.updated', key: `attribution:revision:${token}`, requirementId: req, data: { id, reason, ...(by.type === 'human' ? {} : { status: 'attributed' }) }, actor: by },
  ], { baseRevision: { defectId: id, revision: options.baseRevision } })
  return readQualityDefect(stores, req, id)
}

export async function attributeDefectCheckpoints(deps: EngineDeps, req: string, id: string, options: AttributionWriteOptions): Promise<DefectDetail> {
  requireReason(options.reason); requireRevision(options.baseRevision)
  const defect = await readQualityDefect(deps.stores, req, id)
  if (defect.attribution?.confirmed || ['confirmed', 'closed'].includes(defect.status)) throw new Error('人工确认的归因不能自动覆盖；请由人改判检查点')
  const artifacts = await deps.stores.workspaces.listArtifacts(req)
  for (const artifact of artifacts.filter(item => item.kind !== 'defect')) for (const version of artifact.versions) {
    const source = version.producedBy
    const snapshot = source ? await deps.stores.runs.getWorkflow(source.runId) : undefined
    if (version.author.type === 'agent' && version.author.role === 'auditor'
      || source && snapshotNodes(snapshot?.nodes ?? []).some(node => node.id === source.nodeId && node.role === 'auditor')) {
      throw new Error('auditor 必须不同于任何产出角色；请配置独立审计角色')
    }
  }
  const precheck = await precheckDefect(deps.stores, defect)
  let checkpoints = await precheckDefectCheckpoints(deps.stores, defect)
  const material = await Promise.all(checkpoints.map(async item => ({ ...item,
    files: item.checkpoint.snapshot ? (await snapshotMaterials(deps.stores.taktDir, item.checkpoint.snapshot)).map(file => ({ ...file, content: file.content.toString() })) : [],
  })))
  const prompt = `你是独立归因审计员，只输出候选，不得确认。逐检查点判断①缺陷当时已存在（引入早于检查点且快照版本含缺陷）、③在职责内、⑤输出没提出，逐项附可核对证据；②材料提供、④完成状态以预检为准。证明不了就省略条件，不能用 out_of_scope 代替未知。readOnly=none 只能证明提供了材料，不能证明实际读取。不得从当前文件推断历史。\n${JSON.stringify({ defect, precheck, checkpoints: material })}\n输出满足 ${JSON.stringify(checkpointAttributionSchema)}`
  const response = await readOnlyModel(deps, 'auditor', prompt, checkpointAttributionSchema)
  validateSchema(response.data, checkpointAttributionSchema)
  const raw = response.data as DefectAttribution
  if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) throw new Error('归因置信度不合法；请重试审计')
  const runs = await deps.stores.runs.list({ requirementId: req })
  for (const source of [raw.introducedAt, ...raw.missedBy]) {
    if (!source.evidence.length || source.evidence.some(item => !item.trim())) throw new Error('归因缺少证据；请补齐后重试')
    if (source.runId) assertRunId(source.runId)
    if (source.nodeId) assertNodeId(source.nodeId)
    if (!source.nodeId) continue
    const matches = runs.filter(run => (!source.runId || run.runId === source.runId) && run.nodes[source.nodeId!])
    if (matches.length !== 1) throw new Error('归因节点不存在或不唯一；请核对运行与节点身份')
    source.runId = matches[0]!.runId
  }
  const introduced = raw.introducedAt.artifact
  if (introduced) {
    assertArtifactPath(introduced.path)
    if (introduced.workspace !== req || !Number.isSafeInteger(introduced.version) || !await deps.stores.workspaces.readArtifact(introduced)) throw new Error('引入产物不是本需求的精确版本；请核对冻结材料')
    const observationRefs = defect.observationsDetail?.flatMap(item => item.artifacts ?? []) ?? []
    checkpoints = await precheckDefectCheckpoints(deps.stores, defect, [...observationRefs, introduced])
  }
  const seen = new Set<string>()
  for (const item of raw.checkpoints ?? []) {
    if (seen.has(item.checkpointId) || !checkpoints.some(point => point.checkpoint.id === item.checkpointId)) throw new Error('归因引用未知或重复检查点；请按提供的清单重试')
    seen.add(item.checkpointId)
  }
  const by: Actor = { type: 'agent', role: 'auditor', harness: deps.profiles.auditor!.harness.harness }
  const assessments = checkpoints.map(item => {
    const proposal = raw.checkpoints?.find(candidate => candidate.checkpointId === item.checkpoint.id)
    if (proposal) {
      proposal.conditions = { ...proposal.conditions }
      if (!introduced && !(raw.introducedAt.runId && raw.introducedAt.nodeId)) delete proposal.conditions.existed
      if (introduced) {
        const version = artifacts.find(artifact => artifact.path === introduced.path)?.versions.find(value => value.version === introduced.version)
        if (!version) delete proposal.conditions.existed
        else if (Date.parse(version.createdAt) >= Date.parse(item.checkpoint.scheduledAt)) proposal.conditions.existed = false
      }
    }
    return assessCheckpoint(item, proposal)
  })
  const attribution: DefectAttribution = { defectId: id, introducedAt: raw.introducedAt, missedBy: raw.missedBy,
    confidence: raw.confidence, suggestions: raw.suggestions, precheck, by, at: new Date().toISOString(),
    checkpoints: assessments }
  return saveAttribution(deps.stores, req, id, attribution, by, options)
}

export async function decideCheckpointMiss(stores: ProjectStores, req: string, id: string, checkpointId: string,
  request: MissDecisionRequest, by: Actor, options: AttributionWriteOptions): Promise<DefectDetail> {
  requireHuman(by); requireReason(options.reason); requireRevision(options.baseRevision)
  if (!['should_have_caught', 'caught_but_waived', 'material_missing', 'not_executed', 'out_of_scope', 'undetermined'].includes(request.verdict)) throw new Error('漏检结论不合法；请重新选择')
  if (request.conditions) validateSchema(request.conditions, conditionsSchema)
  const defect = await readQualityDefect(stores, req, id), old = defect.attribution
  const refs = [...(defect.observationsDetail?.flatMap(item => item.artifacts ?? []) ?? []), ...(old?.introducedAt.artifact ? [old.introducedAt.artifact] : [])]
  const point = (await precheckDefectCheckpoints(stores, defect, refs)).find(item => item.checkpoint.id === checkpointId)
  if (!point) throw new Error('检查点不存在或不属于本需求；请刷新检查点列表')
  const previous = old?.checkpoints?.find(item => item.checkpointId === checkpointId)
  const conditions = { ...previous?.conditions, ...request.conditions, ...point.assessment.conditions }
  for (const key of ['executed', 'materialProvided'] as const) {
    if (request.conditions?.[key] !== undefined && request.conditions[key] !== point.assessment.conditions[key]) throw new Error('人工条件与确定性预检不一致；请先修复检查点或快照证据')
  }
  // 没有预检依据时也不能沿用旧的材料判断。
  conditions.materialProvided = point.assessment.conditions.materialProvided
  if (point.raised || point.caughtButWaived) conditions.notRaised = false
  if (request.verdict !== 'undetermined' && missVerdict(conditions, point.caughtButWaived) !== request.verdict) throw new Error('结论不满足所需条件；请补充证据或选择 undetermined')
  if (request.verdict === 'out_of_scope' && !point.checkpoint.duties?.length && !point.checkpoint.snapshot?.duties.length) throw new Error('缺少明确职责条目；请选择 undetermined')
  const at = new Date().toISOString(), reason = requireReason(options.reason)
  const assessment: MissAssessment = { ...point.assessment, conditions, verdict: request.verdict, by: 'human',
    evidence: [...point.assessment.evidence, ...(previous?.evidence ?? []), request.note?.trim() || reason], confirmed: { by, at, note: request.note ?? reason } }
  const attribution: DefectAttribution = old ? { ...old, checkpoints: [...(old.checkpoints ?? []).filter(item => item.checkpointId !== checkpointId), assessment] }
    : { defectId: id, introducedAt: { origin: 'unknown', evidence: ['尚未确认引入点'] }, missedBy: [], confidence: 0,
      suggestions: [], precheck: {}, by, at, checkpoints: [assessment] }
  return saveAttribution(stores, req, id, attribution, by, options)
}
