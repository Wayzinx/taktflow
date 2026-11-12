import type { Insights, ProjectStores } from '../interfaces.js'
import type { EventType, RequirementMetrics, RunState, TraceGraph, WorkflowSnapshot } from '../types.js'
import { acCoverage, readArtifactData } from './artifacts.js'
import { eventMetrics } from './event-metrics.js'
import { buildTraceGraph } from './trace.js'
import { addUsage, summarizeUsage } from './usage.js'
import { qualityMetrics } from './quality.js'
import { runDigest } from './run-digest.js'
import { buildRunGraph, stageProgress } from './graph.js'
import { deriveRequirementState } from './requirement.js'

/** 质量计数用到的事件类型：摘要里只留这些，不把整份事件放进缓存。 */
const QUALITY_TYPES = new Set<EventType>(['gate.result', 'review.round', 'judge.verdict', 'node.checks', 'retry.suppressed'])

/**
 * 准出时间：最近一次流水线运行按 deriveRequirementState 判为已交付时，最终阶段人工签字的时间；
 * 最终阶段没有人工节点时取该阶段最后完成的节点（交付校验）。updatedAt、运行结束时间都不是准出。
 */
function deliveredAt(snapshot: WorkflowSnapshot, run: RunState): string | undefined {
  if (deriveRequirementState(snapshot, run).status !== 'delivered') return undefined
  const last = stageProgress(snapshot, run).at(-1)
  const nodes = buildRunGraph(snapshot, run).nodes.filter((node) => node.stage === last?.id && node.status === 'succeeded')
  const humans = nodes.filter((node) => node.kind === 'human')
  return (humans.length ? humans : nodes).map((node) => run.nodes[node.id]?.endedAt).filter((at): at is string => !!at).sort().at(-1)
}
const isPipelineRun = (run: RunState) => run.kind !== 'task' && run.workflowId !== 'lead' && !run.workflowId.startsWith('task:')

export class FsInsights implements Insights {
  constructor(private readonly stores: ProjectStores) {}

  async traceGraph(requirementId: string): Promise<TraceGraph> {
    const [requirement, data] = await Promise.all([
      this.stores.workspaces.getRequirement(requirementId),
      readArtifactData(this.stores.workspaces, requirementId),
    ])
    return buildTraceGraph(requirementId, requirement?.title ?? requirementId, data)
  }

  async metrics(requirementId: string): Promise<RequirementMetrics> {
    const [runs, artifacts, requirement] = await Promise.all([
      this.stores.runs.list({ requirementId }),
      readArtifactData(this.stores.workspaces, requirementId),
      this.stores.workspaces.getRequirement(requirementId),
    ])
    const metrics: RequirementMetrics = {
      requirementId, runs: runs.length, loopIterations: 0, humanInterventions: 0,
      verdicts: {}, usage: { inputTokens: 0, outputTokens: 0 }, acCoverage: acCoverage(artifacts),
    }
    const batches = await Promise.all(runs.map(async (run) => {
      const snapshot = await this.stores.runs.getWorkflow(run.runId)
      const digest = await runDigest(this.stores, run, 'metrics', (events) => ({
        counts: eventMetrics(events, run, snapshot), usage: summarizeUsage(events),
        quality: events.filter((event) => QUALITY_TYPES.has(event.type)), hasEvents: events.length > 0,
      }), snapshot)
      return { runId: run.runId, snapshot, ...digest }
    }))
    metrics.runUsage = Object.fromEntries(batches.map((batch) => [batch.runId, batch.usage]))
    let total = 0
    let passed = 0
    for (const { counts, usage } of batches) {
      total += counts.firstPassTotal
      passed += counts.firstPassPassed
      metrics.loopIterations += counts.loopIterations
      metrics.humanInterventions += counts.humanInterventions
      for (const category of Object.keys(counts.verdicts) as Array<keyof typeof counts.verdicts>) {
        metrics.verdicts[category] = (metrics.verdicts[category] ?? 0) + counts.verdicts[category]!
      }
      metrics.usage = addUsage(metrics.usage, usage)
    }
    metrics.quality = await qualityMetrics(batches.flatMap(batch => batch.quality), { store: this.stores.workspaces, requirementId },
      new Set(batches.filter(batch => batch.hasEvents).map(batch => batch.runId)))
    if (total > 0) metrics.firstPassRate = passed / total
    const latest = runs.filter(isPipelineRun).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId)).at(-1)
    const snapshot = batches.find((batch) => batch.runId === latest?.runId)?.snapshot
    const at = latest && snapshot && requirement ? deliveredAt(snapshot, latest) : undefined
    if (at) metrics.leadTimeHours = Math.max(0, Date.parse(at) - Date.parse(requirement!.createdAt)) / 3600000
    return metrics
  }
}

export function createInsights(stores: ProjectStores): Insights {
  return new FsInsights(stores)
}
