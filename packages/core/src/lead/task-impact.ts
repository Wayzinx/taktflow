import type { ProjectStores } from '../interfaces.js'
import type { RunState, TaskSpec } from '../types.js'
import { markArtifactEdited } from '../store/artifact-edits.js'

export async function recordTaskImpact(stores: ProjectStores, run: RunState): Promise<void> {
  if (!['succeeded', 'failed', 'cancelled'].includes(run.status) || !run.args.__leadTask || run.origin?.by.type !== 'human') return
  const spec = run.args.__leadTask as TaskSpec
  const events = await stores.events.read(run.runId)
  const edited = new Set(events.filter((event) => event.type === 'artifact.edited').map((event) => (event.data as { ref: { path: string; version?: number } }).ref).map((ref) => `${ref.path}@${ref.version}`))
  const artifacts = await stores.workspaces.listArtifacts(run.requirementId)
  for (const artifact of artifacts) {
    const latest = artifact.versions.at(-1)
    const firstProduced = artifact.versions.findIndex((version) => version.producedBy?.runId === run.runId)
    if (!latest || latest.producedBy?.runId !== run.runId || firstProduced <= 0 || edited.has(`${artifact.path}@${latest.version}`)) continue
    const ref = { workspace: run.requirementId, path: artifact.path, version: latest.version }
    const reason = `Lead 任务：${spec.title}（${spec.impact ?? 'semantic'}）`
    // 修改任务自身已使用最新产物，只让其他运行的旧输入失效。
    const runs = Object.create(stores.runs) as ProjectStores['runs']
    runs.list = async (filter) => (await stores.runs.list(filter)).filter((state) => state.runId !== run.runId)
    await markArtifactEdited({ ...stores, runs }, ref, run.origin.by, reason, spec.impact)
    if (!(await stores.events.read(run.runId, { types: ['artifact.edited'] })).some((event) => {
      const current = (event.data as { ref: typeof ref }).ref
      return current.path === ref.path && current.version === ref.version
    })) await stores.events.append(run.runId, { type: 'artifact.edited', actor: run.origin.by, data: { ref, reason, impact: spec.impact ?? 'semantic' } })
  }
}
