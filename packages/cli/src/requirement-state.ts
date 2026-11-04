import { deriveRequirementState, type ProjectStores, type Requirement, type RunState } from '@taktflow/core'

export function latestRun(runs: RunState[], requirementId: string): RunState | undefined {
  return runs.filter((run) => run.requirementId === requirementId)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId)).at(-1)
}

export async function requirementState(stores: ProjectStores, requirement: Requirement, latest?: RunState): Promise<Requirement> {
  if (!latest || requirement.status === 'archived') return requirement
  const snapshot = await stores.runs.getWorkflow(latest.runId)
  return snapshot ? { ...requirement, ...deriveRequirementState(snapshot, latest) } : requirement
}
