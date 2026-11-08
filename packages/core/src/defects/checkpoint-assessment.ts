import type { CheckpointDetail } from '../api.js'
import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRef, Defect, MissAssessment, MissVerdict, Observation } from '../types.js'
import { nodeQuality } from '../insights/node-quality.js'
import { assertArtifactPath, assertRequirementId } from '../store/paths.js'
import { requireQuality } from './quality-service.js'

export interface CheckpointEvidence {
  checkpoint: CheckpointDetail
  assessment: MissAssessment
  caughtButWaived: boolean
  raised?: boolean
}

export function missVerdict(conditions: MissAssessment['conditions'], caughtButWaived = false): MissVerdict {
  if (conditions.executed === false) return 'not_executed'
  if (caughtButWaived && conditions.notRaised === false) return 'caught_but_waived'
  if (conditions.materialProvided === false) return 'material_missing'
  if (conditions.inDuty === false) return 'out_of_scope'
  if ([conditions.existed, conditions.materialProvided, conditions.inDuty, conditions.executed, conditions.notRaised].every(value => value === true)) return 'should_have_caught'
  return 'undetermined'
}

export function precheckCheckpoint(checkpoint: CheckpointDetail, materials: ArtifactRef[]): MissAssessment {
  const snapshot = checkpoint.snapshot
  for (const material of materials) { assertRequirementId(material.workspace); assertArtifactPath(material.path) }
  // 材料身份与缺陷内容分开：版本相同也不能据此推断缺陷已存在。
  const materialProvided = snapshot && materials.length ? materials.every(material => snapshot.files.some(file =>
    file.ref?.workspace === material.workspace && file.ref.path === material.path)) : undefined
  const conditions: MissAssessment['conditions'] = { executed: checkpoint.status === 'done', ...(materialProvided === undefined ? {} : { materialProvided }) }
  const evidence = [`检查点 ${checkpoint.id} 状态：${checkpoint.status}`,
    snapshot ? `快照 ${snapshot.dir}；只读方式 ${snapshot.readOnly}；材料匹配 ${materialProvided ?? 'unknown'}` : '未记录快照清单，材料是否提供无法判断']
  if (!materials.length) evidence.push('未确定相关材料，不能断言没给材料')
  return { checkpointId: checkpoint.id, runId: checkpoint.runId, nodeId: checkpoint.nodeId,
    conditions, verdict: missVerdict(conditions), evidence, by: 'precheck' }
}

function waivedFinding(point: CheckpointDetail, observations: Observation[], selected: Set<string>): boolean {
  const findings = observations.filter(item => item.kind === 'finding' && item.runId === point.runId && item.checkpointId === point.id && selected.has(item.id))
  return findings.some(finding => observations.some((item, index) => (item.kind === 'waived' || item.kind === 'declined')
    && (item.at > finding.at || item.at === finding.at && index > observations.indexOf(finding))
    && (finding.source === 'review' && item.source === 'review' && finding.subject !== undefined && finding.subject === item.subject
      && finding.runId === item.runId && finding.nodeId === item.nodeId || selected.has(item.id))))
}

export async function precheckDefectCheckpoints(stores: ProjectStores, defect: Defect, materials?: ArtifactRef[]): Promise<CheckpointEvidence[]> {
  assertRequirementId(defect.requirementId)
  const observations = await requireQuality(stores).observations({ requirementId: defect.requirementId })
  const selected = new Set(defect.observations)
  const refs = materials ?? observations.filter(item => selected.has(item.id)).flatMap(item => item.artifacts ?? [])
  const result: CheckpointEvidence[] = []
  for (const run of await stores.runs.list({ requirementId: defect.requirementId })) {
    // 包括调度后没有执行的节点，不从 node.started 推断检查点存在与否。
    for (const nodeId of Object.keys(run.nodes)) for (const point of (await nodeQuality(stores, run.runId, nodeId)).checkpoints) {
      if (['producer', 'author', 'planner'].includes(point.role)) continue
      const raised = observations.some(item => selected.has(item.id) && item.kind === 'finding' && item.runId === point.runId && item.checkpointId === point.id)
      result.push({ checkpoint: point, assessment: precheckCheckpoint(point, refs), caughtButWaived: waivedFinding(point, observations, selected), raised })
    }
  }
  return result
}

export function assessCheckpoint(evidence: CheckpointEvidence, proposal?: Pick<MissAssessment, 'conditions' | 'evidence'>): MissAssessment {
  const base = evidence.assessment
  const supported = !!proposal?.evidence.length && proposal.evidence.every(item => !!item.trim())
  const conditions = { ...base.conditions }
  if (supported) {
    conditions.existed = proposal.conditions.existed
    // 明确的职责才支持在 / 不在职责内；缺失条目不是不在职责的证明。
    if (evidence.checkpoint.snapshot?.duties.length || evidence.checkpoint.duties?.length) conditions.inDuty = proposal.conditions.inDuty
    // 没有当次结构化输出时，不能仅凭模型一句话断言没提出。
    if (evidence.checkpoint.record || evidence.checkpoint.gate) conditions.notRaised = proposal.conditions.notRaised
  }
  if (evidence.raised || evidence.caughtButWaived) conditions.notRaised = false
  return { ...base, conditions, verdict: missVerdict(conditions, evidence.caughtButWaived), by: supported ? 'auditor' : 'precheck',
    evidence: [...base.evidence, ...(supported ? proposal.evidence : []), ...(evidence.caughtButWaived ? ['同一问题的 finding 之后存在不采纳 / 人工放行观察'] : [])] }
}
