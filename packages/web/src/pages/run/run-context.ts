import type { RunSummary } from '@taktflow/core'

export function latestRun(runs: RunSummary[]): RunSummary | undefined {
  return [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId)).at(-1)
}

export function supersededBy(runs: RunSummary[], self: Pick<RunSummary, 'runId' | 'startedAt' | 'kind'>): RunSummary | undefined {
  if (self.kind === 'task') return undefined
  return latestRun(runs.filter(r => r.kind !== 'task' && r.runId !== self.runId
    && (r.startedAt > self.startedAt || (r.startedAt === self.startedAt && r.runId > self.runId))))
}
