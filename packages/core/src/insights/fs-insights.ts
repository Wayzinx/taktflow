import type { Insights, ProjectStores } from '../interfaces.js'
import type { RequirementMetrics, TraceGraph } from '../types.js'
import { acCoverage, readArtifactData } from './artifacts.js'
import { eventMetrics } from './event-metrics.js'
import { buildTraceGraph } from './trace.js'
import { addUsage, summarizeUsage } from './usage.js'
import { qualityMetrics } from './quality.js'

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
    const [runs, artifacts] = await Promise.all([
      this.stores.runs.list({ requirementId }),
      readArtifactData(this.stores.workspaces, requirementId),
    ])
    const metrics: RequirementMetrics = {
      requirementId, runs: runs.length, loopIterations: 0, humanInterventions: 0,
      verdicts: {}, usage: { inputTokens: 0, outputTokens: 0 }, acCoverage: acCoverage(artifacts),
    }
    const batches = await Promise.all(runs.map(async (run) => {
      const [events, snapshot] = await Promise.all([this.stores.events.read(run.runId), this.stores.runs.getWorkflow(run.runId)])
      return { runId: run.runId, events, counts: eventMetrics(events, run, snapshot), usage: summarizeUsage(events) }
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
    metrics.quality = await qualityMetrics(batches.flatMap(batch => batch.events), { store: this.stores.workspaces, requirementId })
    if (total > 0) metrics.firstPassRate = passed / total
    return metrics
  }
}

export function createInsights(stores: ProjectStores): Insights {
  return new FsInsights(stores)
}
