import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { RunState, WorkflowSnapshot } from '../types.js'
import { deriveRequirementState } from '../insights/requirement.js'
import { assertRequirementId } from '../store/paths.js'
import { withFileLock } from '../store/file-lock.js'

export const requirementLock = (stores: ProjectStores, id: string): string => join(stores.taktDir, 'runs', `.requirement-${assertRequirementId(id)}`)

export async function updateRequirement(stores: ProjectStores, state: RunState, snapshot?: WorkflowSnapshot): Promise<void> {
  await withFileLock(requirementLock(stores, state.requirementId), async () => {
    const runs = await stores.runs.list({ requirementId: state.requirementId })
    const latest = runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId)).at(-1)
    if (latest?.runId !== state.runId) return
    const workflow = snapshot ?? await stores.runs.getWorkflow(state.runId)
    if (!workflow) throw new Error(`运行缺少 workflow 快照：${state.runId}`)
    await stores.workspaces.updateRequirement(state.requirementId, deriveRequirementState(workflow, state))
  })
}
