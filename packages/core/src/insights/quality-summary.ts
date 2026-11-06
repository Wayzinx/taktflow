import type { ProjectStores } from '../interfaces.js'
import type { DefectCategory, DefectResolution, DefectValidity } from '../quality.js'
import { buildRunGraph } from './graph.js'
import { checkpoints, raisedEvidence } from './quality-checkpoints.js'
import { confirmedAttribution, discovery, qualityStore, QualityData } from './quality-data.js'

export interface QualitySummary {
  requirementId?: string
  defects: {
    total: number
    byValidity: Record<DefectValidity, number>
    byResolution: Record<DefectResolution, number>
    byCategory: Record<DefectCategory | 'unknown', number>
  }
  stages: { confirmed: number; unknown: number; counts: Array<{ injected: string; discovered: string; count: number }> }
  checkpoints: {
    confirmedDefects: number
    intercepted: number
    missed: number
    caughtButOverridden: number
    counts: Array<{ checkpointId: string; intercepted: number; missed: number; caughtButOverridden: number }>
  }
  counting: { defects: string; categories: string; stages: string; checkpoints: string; limitations: string[] }
}

export async function qualitySummary(stores: ProjectStores, requirementId?: string): Promise<QualitySummary> {
  const quality = qualityStore(stores)
  const [defects, observations, data] = await Promise.all([
    quality.defects({ requirement: requirementId }), quality.observations({ requirement: requirementId }), QualityData.read(stores),
  ])
  const stagesByRun = new Map<string, Map<string, string>>()
  await Promise.all(data.runs.map(async (run) => {
    const snapshot = await stores.runs.getWorkflow(run.runId)
    if (snapshot) stagesByRun.set(run.runId, new Map(buildRunGraph(snapshot, run, [], data.events.filter((event) => event.runId === run.runId)).nodes.map((node) => [node.id, node.stage ?? 'unknown'])))
  }))
  const stage = (runId?: string, nodeId?: string): string => runId && nodeId ? stagesByRun.get(runId)?.get(nodeId) ?? 'unknown' : 'unknown'
  const entries = checkpoints(data)
  const view: QualitySummary = { requirementId,
    defects: { total: defects.length, byValidity: { unconfirmed: 0, valid: 0, not_a_defect: 0, duplicate: 0 },
      byResolution: { open: 0, claimed_fixed: 0, verified_fixed: 0, accepted_risk: 0, reopened: 0 },
      byCategory: { requirement: 0, design: 0, test_design: 0, code: 0, automation: 0, knowledge: 0, environment: 0, process: 0, unknown: 0 } },
    stages: { confirmed: 0, unknown: 0, counts: [] },
    checkpoints: { confirmedDefects: 0, intercepted: 0, missed: 0, caughtButOverridden: 0, counts: [] },
    counting: {
      defects: '按当前缺陷实体各计一次；validity/resolution 包括未确认、非缺陷及重复项。',
      categories: '只采用人确认归因的 category；未确认、争议、未知或无分类归入 unknown。',
      stages: '只统计 validity=valid 且归因由人 confirmed 的缺陷；引入调用/版本 producedBy 与最早 found/still_open 观察映射到历史运行阶段，每缺陷计一次；缺任一阶段计入 unknown。',
      checkpoints: '只统计 validity=valid 且归因由人 confirmed 的样本，按 defectId + checkpointId 去重。拦截=完成检查点提出已关联问题且未被拒绝/放行；漏拦=人工确认的 should_have_caught；caught_but_overridden 单列，不算成功拦截或未提出问题的漏拦。其他状态及自动建议不进入这三个计数。',
      limitations: ['仅覆盖已发现且已确认样本，不能推算总体缺陷率或真实检出率。', '同 key 仅在同运行、节点、attempt、评审者范围比较；跨范围需人显式关联观察。'],
    } }
  const stageCounts = new Map<string, QualitySummary['stages']['counts'][number]>()
  const checkpointCounts = new Map<string, QualitySummary['checkpoints']['counts'][number]>()
  for (const defect of defects) {
    view.defects.byValidity[defect.validity]++
    view.defects.byResolution[defect.resolution]++
    const attribution = confirmedAttribution(defect)
    view.defects.byCategory[attribution?.category ?? 'unknown']++
    if (defect.validity !== 'valid' || !attribution) continue
    const linked = observations.filter((item) => defect.observations.includes(item.id))
    const found = discovery(data, linked)
    const injectedCall = attribution.injected?.invocationId ? data.invocations.get(attribution.injected.invocationId)?.invocation : undefined
    const produced = attribution.injected ? (await data.version(attribution.injected.artifact)).version?.producedBy : undefined
    const injected = stage(injectedCall?.runId ?? produced?.runId, injectedCall?.nodeId ?? produced?.nodeId)
    const discoveredCall = found?.invocationId ? data.invocations.get(found.invocationId)?.invocation : undefined
    const foundCheckpoint = entries.find((entry) => entry.checkpoint.checkpointId === found?.checkpointId)?.checkpoint
    const discovered = stage(found?.runId ?? discoveredCall?.runId ?? foundCheckpoint?.runId, found?.nodeId ?? discoveredCall?.nodeId ?? foundCheckpoint?.nodeId)
    view.stages.confirmed++
    if (injected === 'unknown' || discovered === 'unknown') view.stages.unknown++
    const key = JSON.stringify([injected, discovered])
    const cell = stageCounts.get(key) ?? { injected, discovered, count: 0 }
    cell.count++; stageCounts.set(key, cell)
    view.checkpoints.confirmedDefects++
    const raisedByCheckpoint = new Map(entries.map((entry) => [entry.checkpoint.checkpointId, raisedEvidence(data, entry, linked, observations)]))
    const ids = new Set([...attribution.escapes.map((escape) => escape.checkpointId),
      ...[...raisedByCheckpoint].filter(([, raised]) => raised.raised).map(([id]) => id)])
    for (const checkpointId of ids) {
      // 重复且互相矛盾的人工记录不静默任选一个。
      const verdicts = new Set(attribution.escapes.filter((escape) => escape.checkpointId === checkpointId).map((escape) => escape.verdict))
      if (verdicts.size > 1) continue
      const verdict = [...verdicts][0]
      const entry = entries.find((item) => item.checkpoint.checkpointId === checkpointId)
      const raised = raisedByCheckpoint.get(checkpointId)
      const bucket = verdict === 'should_have_caught' ? 'missed' : verdict === 'caught_but_overridden' ? 'caughtButOverridden'
        : verdict === undefined && entry?.checkpoint.status === 'completed' && entry.result && raised?.raised && !raised.overrides.length ? 'intercepted' : undefined
      if (!bucket) continue
      const counts = checkpointCounts.get(checkpointId) ?? { checkpointId, intercepted: 0, missed: 0, caughtButOverridden: 0 }
      counts[bucket]++; view.checkpoints[bucket]++; checkpointCounts.set(checkpointId, counts)
    }
  }
  view.stages.counts = [...stageCounts.values()].sort((a, b) => a.injected.localeCompare(b.injected) || a.discovered.localeCompare(b.discovered))
  view.checkpoints.counts = [...checkpointCounts.values()].sort((a, b) => a.checkpointId.localeCompare(b.checkpointId))
  return view
}
