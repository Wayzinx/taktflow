import type { ProjectStores } from '../interfaces.js'
import type { AttributionView, Escape } from '../quality.js'
import { isObject } from './artifacts.js'
import { candidateGraph } from './attribution.js'
import { checkpoints, raisedEvidence, type CheckpointEvidence } from './quality-checkpoints.js'
import { artifactKey, comparePoints, confirmedAttribution, defectContext, discovery, eventLabel, eventPoint, eventsOf, sameArtifact, type QualityData } from './quality-data.js'
import { retrieveText, type TextRetrieval } from './quality-text.js'

export interface EscapeCondition {
  condition: 'defect_present' | 'materials_visible' | 'duty_matches' | 'completed' | 'not_raised'
  status: 'supported' | 'not_supported' | 'unknown'
  evidence: string[]
}

export interface EscapeSuggestion extends Escape {
  suggested: true
  candidate: boolean
  conditions: EscapeCondition[]
  checkpoint: CheckpointEvidence['checkpoint']
  checklist: string[]
  retrieval: Array<{ source: string; result: TextRetrieval }>
}

export interface EscapeAnalysis {
  defectId: string
  revision: number
  suggested: true
  status: 'candidate' | 'undetermined'
  injected?: AttributionView['injected']
  discoveryObservationId?: string
  checkpoints: EscapeSuggestion[]
  notes: string[]
}

async function checklist(data: QualityData, entry: CheckpointEvidence): Promise<{ items: string[]; evidence: string[] }> {
  const call = entry.checkpoint.invocationId ? data.invocations.get(entry.checkpoint.invocationId) : undefined
  const duty = entry.checkpoint.duty
  const frozen = duty && call?.inputSnapshot.render.assets.find((asset) => asset.kind === duty.kind && asset.id === duty.id && asset.sha256 === duty.sha256 && asset.revision === duty.revision)
  const object = frozen?.object ?? duty?.sha256
  if (!object) return { items: [], evidence: ['缺少冻结职责资产，不能从当前 workflow 推断职责。'] }
  const text = await data.object(object)
  if (text === undefined) return { items: [], evidence: [`职责正文缺失：${object}`] }
  let value: unknown
  try { value = JSON.parse(text) } catch { return { items: [], evidence: [`职责 ${object} 无可识别的 checklist。`] } }
  const items = isObject(value) && Array.isArray(value.checklist) ? value.checklist.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : []
  return { items, evidence: [`冻结职责对象：${object}`, ...items] }
}

export async function escapeAnalysis(stores: ProjectStores, defectId: string, injected?: AttributionView['injected']): Promise<EscapeAnalysis> {
  const { data, defect, observations, linked, query } = await defectContext(stores, defectId)
  const confirmed = confirmedAttribution(defect)
  const introduction = injected ?? confirmed?.injected
  const found = discovery(data, linked)
  const view: EscapeAnalysis = { defectId, revision: defect.revision, suggested: true, status: 'undetermined', injected: introduction,
    discoveryObservationId: found?.id, checkpoints: [], notes: ['全部为建议；should_have_caught 是待人核对五项条件的候选，不写质量日志。',
      '区间含发现检查点；发现点取关联观察中最早的 found/still_open，拒绝或放行可发生在发现之后。'] }
  if (!introduction || !found) { view.notes.push('缺少人工确认的引入点或发现观察，无法界定检查区间。'); return view }
  if (injected) view.notes.push('显式 injected 仅用于预览；传参不等于已经人工确认。')
  const { version } = await data.version(introduction.artifact)
  if (!version) { view.notes.push('引入点缺少明确版本，不能使用当前产物替代。'); return view }
  const touch = eventsOf(data.events, 'artifact.touched').find((event) => artifactKey(event.data.ref) === artifactKey(introduction.artifact)
    && event.data.relation !== 'reused' && (!introduction.invocationId || event.data.invocationId === introduction.invocationId))
  const start = touch ? eventPoint(touch) : { at: version.createdAt }
  const end = data.observationPoint(found)
  if (comparePoints(start, end) >= 0) { view.notes.push('引入点不早于发现点，无法形成漏拦区间。'); return view }
  const graph = await candidateGraph(data, defect, linked, query)
  const relevant = [...graph.candidates.map((item) => item.artifact), introduction.artifact]
  const runIds = new Set(data.runs.filter((run) => run.requirementId === defect.requirementId).map((run) => run.runId))
  for (const entry of checkpoints(data)) {
    const cp = entry.checkpoint
    if (!runIds.has(cp.runId) || comparePoints(entry.point, start) < 0 || comparePoints(entry.point, end) > 0) continue
    const completed = cp.status === 'completed' && entry.completed !== undefined && comparePoints(eventPoint(entry.completed), end) <= 0
    const materials = cp.materials.filter((item) => relevant.some((ref) => sameArtifact(ref, item.ref)))
    const exposed = materials.length > 0
    const retrieval: EscapeSuggestion['retrieval'] = []
    for (const material of materials) {
      const frozen = await data.version(material.ref)
      if (material.sha256 && frozen.version && material.sha256 !== frozen.version.sha256) throw new Error(`检查点材料 hash 不一致：${cp.checkpointId} ${artifactKey(material.ref)}`)
      const text = await data.text(material.ref)
      retrieval.push({ source: artifactKey(material.ref), result: retrieveText(text ?? '', query) })
    }
    const duty = await checklist(data, entry)
    retrieval.push({ source: 'checklist', result: retrieveText(duty.items.join('\n\n'), query) })
    const raised = raisedEvidence(data, entry, linked, observations)
    const exact = materials.some((item) => artifactKey(item.ref) === artifactKey(introduction.artifact) && item.sha256 === version.sha256)
    const older = materials.length > 0 && materials.every((item) => sameArtifact(item.ref, introduction.artifact)
      && item.ref.version !== undefined && item.ref.version < version.version)
    const conditions: EscapeCondition[] = [
      { condition: 'defect_present', status: older ? 'not_supported' : exact && !injected && confirmed ? 'supported' : 'unknown',
        evidence: [introduction.diffEvidence, ...materials.map((item) => `${artifactKey(item.ref)} sha256=${item.sha256 || 'unknown'}`),
          '时间先后与关键词命中不能证明其他版本仍包含缺陷。'] },
      { condition: 'materials_visible', status: exposed ? 'supported' : 'not_supported', evidence: [entry.scheduled ? eventLabel(entry.scheduled) : '只有 review.result 材料列表，缺少调度时正文 hash。', ...materials.map((item) => artifactKey(item.ref))] },
      { condition: 'duty_matches', status: 'unknown', evidence: [...duty.evidence, '条目与缺陷的对应关系需人确认；文本检索不是职责判断。'] },
      { condition: 'completed', status: completed ? 'supported' : 'not_supported', evidence: [entry.completed ? eventLabel(entry.completed) : `检查点状态：${cp.status}，无完成结果`] },
      { condition: 'not_raised', status: !completed ? 'unknown' : raised.raised ? 'not_supported' : 'supported',
        evidence: raised.raised ? raised.evidence : ['完成结果没有已关联的同 key 问题；未带 key 的同义描述仍需人工核对。'] },
    ]
    const verdict = !exposed ? 'not_exposed' : !completed ? 'not_executed'
      : raised.raised && raised.overrides.length > 0 && defect.validity === 'valid' ? 'caught_but_overridden'
        : duty.items.length > 0 && !raised.raised && !older ? 'should_have_caught' : 'undetermined'
    view.checkpoints.push({ checkpointId: cp.checkpointId, invocationId: cp.invocationId, runId: cp.runId, nodeId: cp.nodeId,
      attempt: cp.attempt, round: cp.round, reviewer: cp.reviewer, checkId: cp.checkId, verdict,
      rationale: verdict === 'should_have_caught' ? '有冻结 checklist 且未发现已关联问题；五项条件仍需人工核对。'
        : verdict === 'caught_but_overridden' ? '问题已确认有效，检查点提出的问题随后被拒绝或放行。'
          : verdict === 'not_exposed' ? '材料清单不含候选链中的相关产物。'
            : verdict === 'not_executed' ? '截至发现时没有成功完成的评审结果。' : '现有证据不足，不能认定漏拦或超出职责。',
      evidence: conditions.flatMap((condition) => condition.evidence), suggested: true, candidate: verdict === 'should_have_caught',
      conditions, checkpoint: cp, checklist: duty.items, retrieval })
  }
  view.status = 'candidate'
  return view
}
